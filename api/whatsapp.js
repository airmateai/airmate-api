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

const ES_DAYS = { lunes:1, martes:2, miércoles:3, miercoles:3, jueves:4, viernes:5, sábado:6, sabado:6, domingo:0 };

function parseDate(str) {
  if (!str) return null;
  const s = str.trim().toLowerCase();
  /* Already YYYY-MM-DD */
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  /* Relative */
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Atlantic/Canary' }));
  if (s === 'hoy') return now.toISOString().slice(0,10);
  if (s === 'mañana' || s === 'manana') {
    now.setDate(now.getDate() + 1);
    return now.toISOString().slice(0,10);
  }
  /* Day name → next occurrence */
  const target = ES_DAYS[s];
  if (target !== undefined) {
    const cur = now.getDay();
    let diff = target - cur;
    if (diff <= 0) diff += 7;
    now.setDate(now.getDate() + diff);
    return now.toISOString().slice(0,10);
  }
  return null;
}

function twiml(msg) {
  const safe = String(msg)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${safe}</Message></Response>`;
}

function buildSystemPrompt(cfg) {
  const svcsRaw = typeof cfg.svcs_json === 'string' ? JSON.parse(cfg.svcs_json) : cfg.svcs_json;
  const svcsArr = Array.isArray(svcsRaw) ? svcsRaw : [];
  const svcs = svcsArr.length
    ? svcsArr.map(s => `- ${s.name}${s.price ? ' (' + s.price + ')' : ''}${s.duration ? ' — ' + s.duration + ' min' : ''}`).join('\n')
    : '- Consultar disponibilidad';
  const svcNames = svcsArr.length ? svcsArr.map(s => s.name).join(', ') : 'Consultar disponibilidad';
  const today = new Date().toLocaleDateString('es-ES', { timeZone: 'Atlantic/Canary', weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit' });

  return `Eres el asistente de "${cfg.bot_name || cfg.slug}" por WhatsApp. Responde siempre muy breve y natural (máx 2 líneas).

SERVICIOS DISPONIBLES: ${svcNames}
HORARIO: ${cfg.schedule_text || (cfg.open_time + '–' + cfg.close_time)}
HOY ES: ${today}
${cfg.agent_wa ? `CONTACTO DIRECTO: ${cfg.agent_wa}` : ''}

FLUJO DE RESERVA:
1. Si el cliente quiere reservar, recoge: nombre completo, teléfono, servicio (solo de la lista), fecha (YYYY-MM-DD), hora (HH:MM), email.
2. Convierte fechas relativas ("mañana", "el martes") a YYYY-MM-DD usando la fecha de hoy.
3. NO pidas confirmación. En cuanto tengas los 6 datos, escribe EXACTAMENTE esta línea sola al final:
RESERVA_LISTA|nombre|teléfono|servicio|YYYY-MM-DD|HH:MM|email

REGLAS ESTRICTAS:
- Solo acepta servicios de la lista. Si piden otro, diles cuáles son.
- Si piden horario fuera del horario del negocio, propón alternativa dentro del horario.
- Nunca inventes precios ni datos.
- Responde en el idioma del cliente.`;
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

    /* ── Slug directo por URL (número verificado por negocio) ── */
    const urlSlug = (req.query && req.query.slug) ? req.query.slug.toLowerCase().trim() : null;

    /* ── Cargar conversación ── */
    const convRows = await sbGet(`wa_conversations?phone=eq.${encodeURIComponent(phone)}&limit=1`);
    let conv = convRows[0];

    /* ── Sin conversación ── */
    if (!conv) {
      if (urlSlug) {
        /* Número propio del negocio: entrar directo */
        const cfgRows = await sbGet(`bot_configs?slug=eq.${encodeURIComponent(urlSlug)}&limit=1`);
        const cfg = cfgRows[0];
        if (!cfg) return res.send(twiml('Negocio no encontrado.'));
        await sbPost('wa_conversations', {
          phone, business_slug: urlSlug, history: [], state: 'chatting',
          updated_at: new Date().toISOString()
        });
        const greeting = cfg.greeting || `¡Hola! Soy el asistente de ${cfg.bot_name}. ¿En qué puedo ayudarte?`;
        return res.send(twiml(greeting));
      }
      /* Número compartido Airmate: preguntar negocio */
      const cfgs = await sbGet('bot_configs?select=slug,bot_name&limit=20');
      const list = cfgs.map(c => `• ${c.bot_name} → escribe: ${c.slug}`).join('\n');
      await sbPost('wa_conversations', {
        phone, business_slug: null, history: [], state: 'selecting_business',
        updated_at: new Date().toISOString()
      });
      return res.send(twiml(`¡Hola! 👋 Soy el asistente de Airmate.\n\n¿Con qué negocio quieres hablar?\n\n${list}`));
    }

    /* ── Seleccionando negocio (número compartido) ── */
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
      const [name, tel, service, rawDate, time, email] = parts;
      const date = parseDate(rawDate);

      let saved = false;
      if (name && tel && service && date && time) {
        const tzHour = new Date().toLocaleString('en-US', { timeZone: 'Atlantic/Canary', timeZoneName: 'shortOffset' }).match(/GMT([+-])(\d+)/);
        const tzOffset = tzHour ? `${tzHour[1]}${String(tzHour[2]).padStart(2,'0')}:00` : '+00:00';
        const starts = new Date(`${date}T${time}:00${tzOffset}`).toISOString();
        const ends   = new Date(new Date(starts).getTime() + 60 * 60000).toISOString();
        saved = await sbPost('appointments', {
          business_slug: conv.business_slug, client_name: name, client_phone: tel,
          client_email: email || null, service, starts_at: starts, ends_at: ends,
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
    return res.send(twiml('Lo siento, ha habido un error. Inténtalo en un momento.'));
  }
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
