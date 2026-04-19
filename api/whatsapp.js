/* ─── Airmate WhatsApp Webhook ─────────────────────────────────────────────
   Recibe mensajes de Twilio Sandbox WhatsApp, consulta el estado de
   conversación en Supabase, llama al proxy IA y responde con TwiML.
   ────────────────────────────────────────────────────────────────────────── */

const SB_URL  = process.env.SB_URL;
const SB_KEY  = process.env.SB_KEY;
const PROXY   = process.env.PROXY_URL || 'https://bot-airmate-1.vercel.app/api/chat';
const TW_SID  = process.env.TWILIO_SID;
const TW_AUTH = process.env.TWILIO_AUTH;

const SB_H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };

async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: SB_H });
  return r.json();
}
async function sbUpsert(table, body, onConflict) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: 'POST',
    headers: { ...SB_H, Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(body)
  });
  return r.json();
}
async function sbPatch(table, filter, body) {
  await fetch(`${SB_URL}/rest/v1/${table}?${filter}`, {
    method: 'PATCH', headers: { ...SB_H, Prefer: 'return=minimal' },
    body: JSON.stringify(body)
  });
}

function twiml(msg) {
  const safe = msg.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${safe}</Message></Response>`;
}

function buildSystemPrompt(cfg) {
  const svcs = (cfg.svcs_json || []).map(s =>
    `- ${s.name}${s.price ? ' (' + s.price + ')' : ''}${s.duration ? ' — ' + s.duration + ' min' : ''}`
  ).join('\n') || '- Consultar disponibilidad';

  return `Eres el asistente de WhatsApp de "${cfg.bot_name || cfg.slug}". Respondes como un dependiente experto y cercano por WhatsApp.

SERVICIOS:
${svcs}

HORARIO: ${cfg.schedule_text || cfg.open_time + '–' + cfg.close_time}

CÓMO ACTÚAS:
- Conversa de forma natural, breve y amable (esto es WhatsApp, no un formulario).
- Informa sobre servicios, precios y horarios cuando te pregunten.
- Cuando el cliente quiera reservar, pídele: nombre, teléfono, servicio, fecha y hora preferida.
- Cuando tengas todos esos datos, responde EXACTAMENTE con esta línea al final:
  RESERVA_LISTA|nombre|teléfono|servicio|fecha|hora
- Nunca inventes precios ni datos que no tengas.
${cfg.agent_wa ? `- Teléfono del negocio: ${cfg.agent_wa}` : ''}

IDIOMA: Responde siempre en el idioma del cliente.`;
}

async function callAI(systemPrompt, history) {
  const r = await fetch(PROXY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ system_prompt: systemPrompt, messages: history.slice(-12) })
  });
  if (!r.ok) throw new Error('AI proxy error ' + r.status);
  const d = await r.json();
  return d.reply || '¿En qué más puedo ayudarte?';
}

async function saveAppointment(slug, parts) {
  /* parts: [nombre, telefono, servicio, fecha, hora] */
  const [name, phone, service, date, time] = parts.map(p => p.trim());
  const starts = new Date(`${date}T${time}:00`).toISOString();
  const ends   = new Date(new Date(starts).getTime() + 60*60000).toISOString();
  const body = {
    business_slug: slug, client_name: name, client_phone: phone, client_email: null,
    service, starts_at: starts, ends_at: ends, duration_minutes: 60,
    status: 'pending', notes: JSON.stringify({ source: 'whatsapp' }),
    created_at: new Date().toISOString()
  };
  const r = await fetch(`${SB_URL}/rest/v1/appointments`, {
    method: 'POST', headers: { ...SB_H, Prefer: 'return=representation' },
    body: JSON.stringify(body)
  });
  return r.ok;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  /* Parsear body de Twilio (application/x-www-form-urlencoded) */
  const raw = await new Promise(resolve => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => resolve(body));
  });
  const params = Object.fromEntries(new URLSearchParams(raw));
  const from    = params.From || '';   /* whatsapp:+34600... */
  const body    = (params.Body || '').trim();
  const phone   = from.replace('whatsapp:', '');

  if (!phone || !body) {
    res.setHeader('Content-Type', 'text/xml');
    return res.send(twiml('Error: mensaje vacío.'));
  }

  try {
    /* ── Cargar o crear conversación ── */
    let convRows = await sbGet(`wa_conversations?phone=eq.${encodeURIComponent(phone)}&select=*&limit=1`);
    let conv = convRows[0];

    /* ── Si no hay conversación: pedir negocio ── */
    if (!conv) {
      /* Listar negocios disponibles */
      const cfgs = await sbGet('bot_configs?select=slug,bot_name&limit=20');
      const list = cfgs.map(c => `• ${c.bot_name} → escribe *${c.slug}*`).join('\n');
      await sbUpsert('wa_conversations', {
        phone, business_slug: null, history: [], state: 'selecting_business',
        updated_at: new Date().toISOString()
      }, 'phone');
      res.setHeader('Content-Type', 'text/xml');
      return res.send(twiml(`¡Hola! 👋 Soy el asistente de Airmate.\n\n¿Con qué negocio quieres hablar?\n\n${list}`));
    }

    /* ── Seleccionando negocio ── */
    if (conv.state === 'selecting_business') {
      const slug = body.toLowerCase().replace(/\s+/g, '-');
      const cfgRows = await sbGet(`bot_configs?slug=eq.${encodeURIComponent(slug)}&select=*&limit=1`);
      const cfg = cfgRows[0];
      if (!cfg) {
        res.setHeader('Content-Type', 'text/xml');
        return res.send(twiml(`No encontré ese negocio. Escribe exactamente el nombre que aparece en la lista.`));
      }
      await sbPatch('wa_conversations', `phone=eq.${encodeURIComponent(phone)}`, {
        business_slug: slug, state: 'chatting', history: [],
        updated_at: new Date().toISOString()
      });
      conv = { ...conv, business_slug: slug, state: 'chatting', history: [] };
      const reply = cfg.greeting || `¡Hola! Soy el asistente de ${cfg.bot_name}. ¿En qué puedo ayudarte?`;
      res.setHeader('Content-Type', 'text/xml');
      return res.send(twiml(reply));
    }

    /* ── Conversación activa ── */
    const cfgRows = await sbGet(`bot_configs?slug=eq.${encodeURIComponent(conv.business_slug)}&select=*&limit=1`);
    const cfg = cfgRows[0];
    if (!cfg) {
      res.setHeader('Content-Type', 'text/xml');
      return res.send(twiml('Error cargando configuración del negocio.'));
    }

    const history = conv.history || [];
    history.push({ role: 'user', content: body });

    const systemPrompt = buildSystemPrompt(cfg);
    const reply = await callAI(systemPrompt, history);

    /* ── Detectar reserva lista ── */
    if (reply.includes('RESERVA_LISTA|')) {
      const line = reply.split('\n').find(l => l.startsWith('RESERVA_LISTA|'));
      const parts = line.replace('RESERVA_LISTA|', '').split('|');
      const ok = await saveAppointment(conv.business_slug, parts);
      const clean = reply.replace(/RESERVA_LISTA\|.*/g, '').trim();
      const extra = ok
        ? `\n\n✅ ¡Reserva guardada! El negocio la confirmará en breve.`
        : `\n\n⚠️ Hubo un problema al guardar. Llama directamente al negocio.`;
      history.push({ role: 'assistant', content: reply });
      await sbPatch('wa_conversations', `phone=eq.${encodeURIComponent(phone)}`, {
        history: history.slice(-20), updated_at: new Date().toISOString()
      });
      res.setHeader('Content-Type', 'text/xml');
      return res.send(twiml((clean || '¡Perfecto!') + extra));
    }

    history.push({ role: 'assistant', content: reply });
    await sbPatch('wa_conversations', `phone=eq.${encodeURIComponent(phone)}`, {
      history: history.slice(-20), updated_at: new Date().toISOString()
    });

    res.setHeader('Content-Type', 'text/xml');
    return res.send(twiml(reply));

  } catch (e) {
    console.error('[WhatsApp webhook]', e);
    res.setHeader('Content-Type', 'text/xml');
    return res.send(twiml('Lo siento, ha habido un error. Inténtalo de nuevo en un momento.'));
  }
}

export const config = { api: { bodyParser: false } };
