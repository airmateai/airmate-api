/* ─── Airmate Email via Resend (CommonJS) ───────────────────────────────── */

const RESEND_KEY = process.env.RESEND_KEY;

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk.toString(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const raw = await readBody(req);
    const { type, negocio, negocioEmail, clienteNombre, clienteEmail, servicio, fecha, hora, duracion, precio } = JSON.parse(raw);

    if (!clienteEmail) return res.status(400).json({ error: 'clienteEmail requerido' });

    const subjects = {
      pending:   `Solicitud recibida en ${negocio} 📋`,
      confirmed: `¡Tu cita está confirmada en ${negocio}! ✅`,
      reminder:  `Recuerda: tienes cita mañana en ${negocio} ⏰`
    };

    const intros = {
      pending:   `Hemos recibido tu solicitud de cita. El negocio la confirmará en breve.`,
      confirmed: `¡Tu cita ha sido confirmada! Te esperamos.`,
      reminder:  `Te recordamos que tienes una cita mañana.`
    };

    const subject = subjects[type] || subjects.confirmed;
    const intro   = intros[type]   || intros.confirmed;

    const html = `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0f2f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f2f7;padding:32px 0">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
        <!-- Header -->
        <tr><td style="background:#0c1e3d;padding:24px 32px;text-align:center">
          <div style="font-size:13px;font-weight:800;color:#22c55e;letter-spacing:.1em;text-transform:uppercase">Airmate</div>
          <div style="font-size:22px;font-weight:800;color:#fff;margin-top:4px">${negocio}</div>
        </td></tr>
        <!-- Body -->
        <tr><td style="padding:32px">
          <p style="font-size:16px;color:#0c1e3d;font-weight:700;margin:0 0 8px">Hola, ${clienteNombre} 👋</p>
          <p style="font-size:14px;color:#6b7d96;margin:0 0 24px;line-height:1.6">${intro}</p>
          <!-- Cita -->
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border-radius:12px;padding:20px;border:1.5px solid #e4e9f2">
            <tr><td style="padding:8px 0;border-bottom:1px solid #e4e9f2">
              <span style="font-size:11px;font-weight:700;color:#8a97b0;text-transform:uppercase;letter-spacing:.05em">Servicio</span><br>
              <span style="font-size:15px;font-weight:700;color:#0c1e3d">${servicio}</span>
            </td></tr>
            <tr><td style="padding:8px 0;border-bottom:1px solid #e4e9f2">
              <span style="font-size:11px;font-weight:700;color:#8a97b0;text-transform:uppercase;letter-spacing:.05em">Fecha y hora</span><br>
              <span style="font-size:15px;font-weight:700;color:#0c1e3d">${fecha} · ${hora}</span>
            </td></tr>
            ${duracion ? `<tr><td style="padding:8px 0;border-bottom:1px solid #e4e9f2">
              <span style="font-size:11px;font-weight:700;color:#8a97b0;text-transform:uppercase;letter-spacing:.05em">Duración</span><br>
              <span style="font-size:15px;font-weight:700;color:#0c1e3d">${duracion} min</span>
            </td></tr>` : ''}
            ${precio ? `<tr><td style="padding:8px 0">
              <span style="font-size:11px;font-weight:700;color:#8a97b0;text-transform:uppercase;letter-spacing:.05em">Precio</span><br>
              <span style="font-size:15px;font-weight:700;color:#0c1e3d">${precio}</span>
            </td></tr>` : ''}
          </table>
          ${negocioEmail ? `<p style="font-size:13px;color:#6b7d96;margin:20px 0 0">¿Necesitas cambiar algo? Escríbenos a <a href="mailto:${negocioEmail}" style="color:#22c55e">${negocioEmail}</a></p>` : ''}
        </td></tr>
        <!-- Footer -->
        <tr><td style="background:#f8fafc;padding:16px 32px;text-align:center;border-top:1px solid #e4e9f2">
          <p style="font-size:11px;color:#8a97b0;margin:0">Gestionado por <strong>Airmate</strong> · airmate.es</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `${negocio} <reservas@airmate.es>`,
        reply_to: negocioEmail || undefined,
        to: [clienteEmail],
        subject,
        html
      })
    });

    const d = await r.json();
    if (!r.ok) throw new Error(d.message || JSON.stringify(d));

    return res.status(200).json({ ok: true, id: d.id });

  } catch (e) {
    console.error('[EMAIL error]', e.message);
    return res.status(500).json({ error: e.message });
  }
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
