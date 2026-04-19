/* ─── Airmate WhatsApp Webhook (CommonJS) ──────────────────────────────── */

const SB_URL  = process.env.SB_URL;
const SB_KEY  = process.env.SB_KEY;
const PROXY   = process.env.PROXY_URL || 'https://bot-airmate-1.vercel.app/api/chat';

const SB_H = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  'Content-Type': 'application/json'
};

async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: SB_H });
  return r.json();
}
async function sbPost(table, body, prefer) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...SB_H, Prefer: prefer || 'return=minimal' },
    body: JSON.stringify(body)
  });
  return r.ok;
}
async function sbPatch(table, filter, body) {
  await fetch(`${SB_URL}/rest/v1/${table}?${filter}`, {
    method: 'PATCH',
    headers: { ...SB_H, Prefer: 'return=minimal' },
    body: JSON.stringify(body)
  });
}

function twiml(msg) {
  const safe = String(msg)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${safe}</Message></Response>`;
}

function buildSystemPrompt(cfg) {
  const svcs = Array.isArray(cfg.svcs_json)
    ? cfg.svcs_json.map(s => `- ${s.name}${s.price ? ' (' + s.price + ')' : ''}${s.duration ? ' — ' + s.duration + ' min' : ''}`).join('\n')
    : '- Consultar disponibilidad';

  return `Eres el asistente de WhatsApp de "${cfg.bot_name || cfg.slug}". Respondes como un dependiente experto y cercano.

SERVICIOS:
${svcs}

HORARIO: ${cfg.schedule_text || (cfg.open_time + '–' + cfg.close_time)}

CÓMO ACTÚAS:
- Conversa de forma natural y breve (esto es WhatsApp).
- Informa sobre servicios y horarios cuando pregunten.
- Cuando el cliente quiera reservar, pídele: nombre, teléfono, servicio, fecha y hora.
- Cuando tengas TODOS esos datos responde con esta línea exacta al final:
  RESERVA_LISTA|nombre|teléfono|servicio|fecha|hora
- Nunca inventes precios ni datos que no tengas.
${cfg.agent_wa ? `- Teléfono directo: ${cfg.agent_wa}` : ''}

IDIOMA: Responde siempre en el idioma del cliente.`;
}

async function callAI(systemPrompt, history) {
  const r = await fetch(PROXY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ system_prompt: systemPrompt, messages: history.slice(-12) })
  });
  if (!r.ok) throw new Error('AI error ' + r.status);
  const d = await r.json();
  return d.reply || '¿En qué más puedo ayudarte?';
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk.toString(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function handler(req, res) {
  res.setHeader('Content-Type', 'text/xml');

  if (req.method !== 'POST') {
    return res.status(405).send(twiml('Método no permitido'));
  }

  try {
    const raw = await readBody(req);
    const params = Object.fromEntries(new URLSearchParams(raw));

    const fromRaw = params.From || '';
    const msgBody = (params.Body || '').trim();
    const phone   = fromRaw.replace('whatsapp:', '');

    console.log('[WA] from:', phone, 'msg:', msgBody);

    if (!phone || !msgBody) {
      return res.send(twiml('No se recibió mensaje.'));
    }

    /* ── Cargar conversación ── */
    const convRows = await sbGet(`wa_conversations?phone=eq.${encodeURIComponent(phone)}&limit=1`);
    let conv = convRows[0];

    /* ── Sin conversación: mostrar negocios ── */
    if (!conv) {
      const cfgs = await sbGet('bot_configs?select=slug,bot_name&limit=20');
      const list = cfgs.map(c => `• ${c.bot_name} → escribe: ${c.slug}`).join('\n');
      await sbPost('wa_conversations', {
        phone,
        business_slug: null,
        history: [],
        state: 'selecting_business',
        updated_at: new Date().toISOString()
      });
      return res.send(twiml(`¡Hola! 👋 Soy el asistente de Airmate.\n\n¿Con qué negocio quieres hablar?\n\n${list}`));
    }

    /* ── Seleccionando negocio ── */
    if (conv.state === 'selecting_business') {
      const slug = msgBody.toLowerCase().trim();
      const cfgRows = await sbGet(`bot_configs?slug=eq.${encodeURIComponent(slug)}&limit=1`);
      const cfg = cfgRows[0];
      if (!cfg) {
        return res.send(twiml('No encontré ese negocio. Escribe exactamente el nombre de la lista.'));
      }
      await sbPatch('wa_conversations', `phone=eq.${encodeURIComponent(phone)}`, {
        business_slug: slug, state: 'chatting', history: [],
        updated_at: new Date().toISOString()
      });
      const greeting = cfg.greeting || `¡Hola! Soy el asistente de ${cfg.bot_name}. ¿En qué puedo ayudarte?`;
      return res.send(twiml(greeting));
    }

    /* ── Conversación activa ── */
    const cfgRows = await sbGet(`bot_configs?slug=eq.${encodeURIComponent(conv.business_slug)}&limit=1`);
    const cfg = cfgRows[0];
    if (!cfg) return res.send(twiml('Error cargando el negocio.'));

    const history = Array.isArray(conv.history) ? conv.history : [];
    history.push({ role: 'user', content: msgBody });

    const reply = await callAI(buildSystemPrompt(cfg), history);

    /* ── Detectar reserva completa ── */
    if (reply.includes('RESERVA_LISTA|')) {
      const line = reply.split('\n').find(l => l.startsWith('RESERVA_LISTA|')) || '';
      const parts = line.replace('RESERVA_LISTA|', '').split('|').map(p => p.trim());
      const [name, tel, service, date, time] = parts;

      let saved = false;
      if (name && tel && service && date && time) {
        const starts = new Date(`${date}T${time}:00`).toISOString();
        const ends   = new Date(new Date(starts).getTime() + 60 * 60000).toISOString();
        saved = await sbPost('appointments', {
          business_slug: conv.business_slug, client_name: name, client_phone: tel,
          client_email: null, service, starts_at: starts, ends_at: ends,
          duration_minutes: 60, status: 'pending',
          notes: JSON.stringify({ source: 'whatsapp' }),
          created_at: new Date().toISOString()
        });
      }

      const clean = reply.replace(/RESERVA_LISTA\|[^\n]*/g, '').trim();
      const extra = saved
        ? '\n\n✅ ¡Reserva guardada! El negocio la confirmará pronto.'
        : '\n\n⚠️ Error guardando. Contacta directamente al negocio.';

      history.push({ role: 'assistant', content: reply });
      await sbPatch('wa_conversations', `phone=eq.${encodeURIComponent(phone)}`, {
        history: history.slice(-20), updated_at: new Date().toISOString()
      });
      return res.send(twiml((clean || '¡Perfecto!') + extra));
    }

    history.push({ role: 'assistant', content: reply });
    await sbPatch('wa_conversations', `phone=eq.${encodeURIComponent(phone)}`, {
      history: history.slice(-20), updated_at: new Date().toISOString()
    });

    return res.send(twiml(reply));

  } catch (e) {
    console.error('[WA error]', e.message, e.stack);
    return res.send(twiml('DEBUG: ' + e.message));
  }
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
