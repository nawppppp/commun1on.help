const PARTICIPANTS = ['vaughn', 'connor', 'chase', 'matthew', 'hasan', 'zach', 'eddie', 'cooper', 'billy', 'aiden'];

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'not allowed' });

  const name = req.body && req.body.name;
  if (!PARTICIPANTS.includes(name)) return res.status(400).json({ error: 'unknown name' });
  if (!process.env.DISCORD_WEBHOOK) return res.status(500).json({ error: 'webhook not configured' });

  try {
    await fetch(process.env.DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: ` **${name}** just logged in` }),
    });
  } catch (e) {
    return res.status(502).json({ error: 'discord unreachable' });
  }
  return res.status(200).json({ ok: true });
};
