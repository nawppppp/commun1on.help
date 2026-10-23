import type { IncomingMessage, ServerResponse } from 'http';
import { URL } from 'url';

export function getAppUrl(req?: IncomingMessage): string {
  if (process.env.APP_URL && process.env.APP_URL.trim() !== '' && process.env.APP_URL !== 'MY_APP_URL') {
    return process.env.APP_URL.replace(/\/+$/, '');
  }
  if (req && req.headers && req.headers.host) {
    const proto = (req.headers['x-forwarded-proto'] as string) || 'https';
    return `${proto}://${req.headers.host}`.replace(/\/+$/, '');
  }
  return 'https://ais-dev-ruwjnpx5n3abtepu34iokm-329977165650.us-west2.run.app';
}

export function getRedirectUri(req?: IncomingMessage): string {
  return `${getAppUrl(req)}/auth/callback`;
}

export async function handleAuthUrl(req: IncomingMessage, res: ServerResponse) {
  const clientId = process.env.DISCORD_CLIENT_ID;
  const redirectUri = getRedirectUri(req);
  const configured = Boolean(clientId && clientId.trim() !== '');

  let authUrl = '';
  if (configured) {
    const params = new URLSearchParams({
      client_id: clientId!,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'identify guilds',
      prompt: 'consent',
    });
    authUrl = `https://discord.com/oauth2/authorize?${params.toString()}`;
  }

  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ configured, url: authUrl, redirectUri }));
}

export async function handleOAuthCallback(req: IncomingMessage, res: ServerResponse) {
  const host = req.headers.host || 'localhost:3000';
  const protocol = (req.headers['x-forwarded-proto'] as string) || 'https';
  const reqUrl = new URL(req.url || '/', `${protocol}://${host}`);
  const code = reqUrl.searchParams.get('code');

  if (!code) {
    sendPopupResponse(res, false, null, 'authorization cancelled or failed.');
    return;
  }

  const clientId = process.env.DISCORD_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  const targetGuildId = process.env.DISCORD_GUILD_ID;
  const redirectUri = getRedirectUri(req);

  try {
    // 1. Exchange code for access token
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId!,
        client_secret: clientSecret!,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }).toString(),
    });

    const tokenData = await tokenRes.json();
    const authHeader = `${tokenData.token_type} ${tokenData.access_token}`;

    // 2. Fetch user profile
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: authHeader },
    });
    const discordUser = await userRes.json();

    // 3. Verify membership in communion guild
    const guildsRes = await fetch('https://discord.com/api/users/@me/guilds', {
      headers: { Authorization: authHeader },
    });
    const guilds = await guildsRes.json();

    const isMember = guilds.some((g: { id: string; name: string }) => {
      if (targetGuildId && targetGuildId.trim() !== '') {
        return g.id === targetGuildId.trim();
      }
      return g.name.toLowerCase().includes('communion');
    });

    if (!isMember) {
      sendPopupResponse(res, false, null, `access denied: @${discordUser.username} is not an authorized member of communion.`);
      return;
    }

    const userProfile = {
      id: discordUser.id,
      username: discordUser.username,
      displayName: (discordUser.global_name || discordUser.username).toLowerCase(),
      avatar: discordUser.avatar
        ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
        : 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=256&h=256&q=80',
      statusText: 'active in communion',
      isOnline: true,
      lastActive: 'just now',
      role: 'member',
      bio: 'verified communion server member via discord oauth2.',
      joinedDate: new Date().toLocaleDateString('en-US', { month: 'short', year: 'numeric' }).toLowerCase(),
    };

    sendPopupResponse(res, true, userProfile, null);
  } catch {
    sendPopupResponse(res, false, null, 'server error during oauth verification.');
  }
}
