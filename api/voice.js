/* ─── Airmate Voice Webhook (CommonJS) ─────────────────────────────────── */

const SB_URL    = process.env.SB_URL;
const SB_KEY    = process.env.SB_KEY;
const PROXY     = process.env.PROXY_URL || 'https://bot-airmate-1.vercel.app/api/chat';
const BASE_URL  = process.env.BASE_URL  || 'https://airmate-api-5sih.vercel.app';

const SB_H = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  'Content-Type': 'application/json'
};

const ES_DAYS = { lunes:1, martes:2, miércoles:3, miercoles:3, jueves:4, viernes:5, sábado:6, sabado:6, domingo:0 };

function parseDate(str) {
  if (!str) return null;
  const s = str.trim().toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Atlantic/Canary' }));
  if (s === 'hoy') return now.toISOString().slice(0,10);
  if (s === 'mañana' || s === 'manana') { now.setDate(now.getDate()+1); return now.toISOString().slice(0,10); }
  const target = ES_DAYS[s];
  if (target !== undefined) {
    const diff = ((target - now.getDay()) + 7) % 7 || 7;
    now.setDate(now.getDate() + diff);
    return now.toISOString().slice(0,10);
  }
  return null;
}

async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: SB_H });
  return r.json();
}
async function sbPost(table, body) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...SB_H, Prefer: 'return=minimal' },
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

function say(text, gather = null) {
  const safe = String(text).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const voice = `<Say language="es-ES" voice="Polly.Lucia-Neural">${safe}</Say>`;
  if (gather) {
    return `<?xml version="1.0" encoding="UTF-8"?><Response>
      <Gather input="speech" language="es-ES" speechTimeout="auto" speechModel="phone_call" enhanced="true" action="${gather}" method="POST">
        ${voice}
      </Gather>
      <Redirect method="POST">${gather}</Redirect>
    </Response>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${voice}<Hangup/></Response>`;
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk.toString(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function buildSystemPrompt(cfg) {
  const svcsRaw = typeof cfg.svcs_json === 'string' ? JSON.parse(cfg.svcs_json) : cfg.svcs_json;
  const svcsArr = Array.isArray(svcsRaw) ? svcsRaw : [];
  const svcNames = svcsArr.length ? svcsArr.map(s => s.name).join(', ') : 'Consultar disponibilidad';
  const today = new Date().toLocaleDateString('es-ES', { timeZone: 'Atlantic/Canary', weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit' });

  return `Eres el asistente telefónico de "${cfg.bot_name || cfg.slug}". Hablas por teléfono — respuestas MUY cortas y naturales.

SERVICIOS: ${svcNames}
HORARIO: ${cfg.schedule_text || (cfg.open_time + '–' + cfg.close_time)}
HOY: ${today}

FLUJO DE RESERVA: Recoge nombre completo, teléfono, servicio, fecha (YYYY-MM-DD), hora (HH:MM) y email. En cuanto tengas los 6 datos escribe al final:
RESERVA_LISTA|nombre|teléfono|servicio|YYYY-MM-DD|HH:MM|email

REGLAS: Solo servicios de la lista. No confirmes datos, reserva directo. Responde en español.`;
}

async function callAI(systemPrompt, history) {
  const r = await fetch(PROXY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ system_prompt: systemPrompt, messages: history.slice(-12) })
  });
  if (!r.ok) throw new Error('AI error ' + r.status);
  const d = await r.json();
  return d.reply || 'Disculpe, ¿puede repetir?';
}

async function handler(req, res) {
  res.setHeader('Content-Type', 'text/xml');

  try {
    const raw = await readBody(req);
    const params = Object.fromEntries(new URLSearchParams(raw));
    const urlSlug = (req.query && req.query.slug) ? req.query.slug.toLowerCase().trim() : null;

    const callSid  = params.CallSid || '';
    const speech   = (params.SpeechResult || '').trim();
    const callStatus = params.CallStatus || '';

    console.log('[VOICE] CallSid:', callSid, 'speech:', speech, 'status:', callStatus);

    if (!callSid) return res.end(say('Error interno.'));

    /* ── Llamada entrante (sin speech aún) ── */
    if (!speech) {
      if (!urlSlug) return res.end(say('Bienvenido a Airmate. Este número no está configurado.'));

      const cfgRows = await sbGet(`bot_configs?slug=eq.${encodeURIComponent(urlSlug)}&limit=1`);
      const cfg = cfgRows[0];
      if (!cfg) return res.end(say('Negocio no encontrado.'));

      const greeting = cfg.greeting || `Hola, gracias por llamar a ${cfg.bot_name}. ¿En qué puedo ayudarle?`;
      const initHistory = [{ role: 'assistant', content: greeting }];
      await sbPost('wa_conversations', {
        phone: callSid, business_slug: urlSlug, history: initHistory, state: 'chatting',
        updated_at: new Date().toISOString()
      });

      const actionUrl = `${BASE_URL}/api/voice?slug=${urlSlug}`;
      return res.end(say(greeting, actionUrl));
    }

    /* ── Turno de conversación ── */
    if (!urlSlug) return res.end(say('Error de configuración.'));

    const convRows = await sbGet(`wa_conversations?phone=eq.${encodeURIComponent(callSid)}&limit=1`);
    const conv = convRows[0];
    if (!conv) return res.end(say('Lo siento, ha habido un error. Llame de nuevo.'));

    const cfgRows = await sbGet(`bot_configs?slug=eq.${encodeURIComponent(urlSlug)}&limit=1`);
    const cfg = cfgRows[0];
    if (!cfg) return res.end(say('Error cargando el negocio.'));

    const history = Array.isArray(conv.history) ? conv.history : [];
    history.push({ role: 'user', content: speech });

    const reply = await callAI(buildSystemPrompt(cfg), history);

    /* ── Detectar reserva completa ── */
    if (reply.includes('RESERVA_LISTA|')) {
      const line = reply.split('\n').find(l => l.startsWith('RESERVA_LISTA|')) || '';
      const parts = line.replace('RESERVA_LISTA|', '').split('|').map(p => p.trim());
      const [name, tel, service, rawDate, time, email] = parts;
      const date = parseDate(rawDate);

      console.log('[VOICE] RESERVA_LISTA parsed:', { name, tel, service, rawDate, date, time, email });
      let saved = false;
      if (name && tel && service && date && time) {
        const tzHour = new Date().toLocaleString('en-US', { timeZone: 'Atlantic/Canary', timeZoneName: 'shortOffset' }).match(/GMT([+-])(\d+)/);
        const tzOffset = tzHour ? `${tzHour[1]}${String(tzHour[2]).padStart(2,'0')}:00` : '+00:00';
        const starts = new Date(`${date}T${time}:00${tzOffset}`).toISOString();
        const ends   = new Date(new Date(starts).getTime() + 60 * 60000).toISOString();
        saved = await sbPost('appointments', {
          business_slug: urlSlug, client_name: name, client_phone: tel,
          client_email: email || null, service, starts_at: starts, ends_at: ends,
          duration_minutes: 60, status: 'pending',
          notes: JSON.stringify({ source: 'voice_call' }),
          created_at: new Date().toISOString()
        });
      }

      const clean = reply.replace(/RESERVA_LISTA\|[^\n]*/g, '').trim();
      const extra = saved ? ' Su reserva ha quedado registrada. El negocio la confirmará pronto. ¡Hasta luego!' : ' Ha habido un error al guardar. Por favor llame de nuevo.';

      await sbPatch('wa_conversations', `phone=eq.${encodeURIComponent(callSid)}`, {
        history: history.slice(-20), updated_at: new Date().toISOString()
      });

      return res.end(say((clean || 'Perfecto.') + extra));
    }

    history.push({ role: 'assistant', content: reply });
    await sbPatch('wa_conversations', `phone=eq.${encodeURIComponent(callSid)}`, {
      history: history.slice(-20), updated_at: new Date().toISOString()
    });

    const actionUrl = `${BASE_URL}/api/voice?slug=${urlSlug}`;
    return res.end(say(reply, actionUrl));

  } catch (e) {
    console.error('[VOICE error]', e.message, e.stack);
    return res.end(say('Lo siento, ha habido un error. Por favor llame de nuevo.'));
  }
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
