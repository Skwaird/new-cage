export default async function handler(req, res) {
  const { subreddit = 'FightPorn', sort = 'hot', after = '' } = req.query;

  try {
    const url = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/${encodeURIComponent(sort)}.json?limit=15${after ? `&after=${encodeURIComponent(after)}` : ''}`;

    const redditRes = await fetch(url, {
      headers: {
        // Reddit blocks requests with no/blank User-Agent — this satisfies that.
        'User-Agent': 'PlanetVerdeFeed/1.0 (Vercel serverless proxy)'
      }
    });

    if (!redditRes.ok) {
      res.status(redditRes.status).json({ error: `Reddit responded ${redditRes.status}` });
      return;
    }

    const data = await redditRes.json();
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}