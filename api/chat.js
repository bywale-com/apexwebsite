// Vercel Serverless Function — POST /api/chat
// Requires OPENAI_API_KEY in Vercel env or .env.local (vercel dev)

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body || '{}');
    } catch {
      body = {};
    }
  }
  if (!body || typeof body !== 'object') {
    body = {};
  }

  const { messages, systemPrompt } = body;

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'Server missing OPENAI_API_KEY' });
  }

  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: 'Invalid messages' });
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt || '' },
        ...messages,
      ],
      response_format: { type: 'json_object' },
      max_tokens: 300,
      temperature: 0.7,
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    return res.status(500).json({
      error: data.error?.message || data.error || 'OpenAI error',
    });
  }

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    return res.status(500).json({ error: 'Empty response from model' });
  }

  return res.status(200).json({ content });
};
