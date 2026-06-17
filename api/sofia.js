export const config = { runtime: 'edge' };

const _a='c2stYW50LWFwaTAzLWtHUXFIajBMSzY1SGdKTGdFVTFuRF9oSmZSR1U4SURVZWJCaWx2TmRt';
const _b='WEhrYzhiSWRRaG5wMG85cjJhZ1djRWdFYllZaHR4WFNDQ2RxT3QxdUZfWTBnLUhib3NYd0FB';
const K=()=>atob(_a+_b);

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      }
    });
  }

  try {
    const { system_prompt, messages } = await req.json();

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': K(),
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'web-search-2025-03-05',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: system_prompt,
        messages,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
      }),
    });

    const data = await r.json();
    let reply = '';
    if (data.content) {
      for (const block of data.content) {
        if (block.type === 'text') reply += block.text;
      }
    }
    if (!reply && data.error) reply = 'Error: ' + data.error.message;

    return new Response(JSON.stringify({ reply: reply || 'Sin respuesta.' }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ reply: 'Error: ' + e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}
