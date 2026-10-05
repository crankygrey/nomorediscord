// NoMoreDiscord runtime configuration.
//
// Players on strict networks (mobile data, office wifi, CGNAT, some routers)
// cannot connect peer-to-peer with STUN alone and will sit on "Connecting"
// forever. A TURN relay fixes that. The free Metered Open Relay gives you
// 20 GB/month at no cost and needs no server:
//
//   1. Create a free account: https://dashboard.metered.ca/signup?tool=turnserver
//   2. Copy your API key and your app subdomain from the dashboard.
//   3. Fill in the two values below and redeploy (or just open the site with the
//      values set, then hard-refresh). Nothing else to change.
//
// Voice uses roughly 50 kbps, so 20 GB/month is several hundred hours of talk.
// The key is visible to anyone using the page, so use a dedicated account.
window.NOMOREDISCORD_CONFIG = {
  // Set to false to run on public STUN alone: no Metered credentials are
  // fetched and no relay candidate is offered. Useful for finding out whether
  // your players actually need TURN - leave it off for a few games, and if
  // nobody gets stuck on "Connecting", you can leave it off for good.
  // `?turn=0` or `?turn=1` in the URL overrides this for a single test run.
  turnEnabled: false,

  // e.g. 'myteam' for https://myteam.metered.live
  meteredApp: 'nomorediscord',
  meteredApiKey: 'c40aa67681426bff38d621c01640363be739',

  // Optional: your own coturn instead of (or as well as) Metered.
  // turnServers: [
  //   { urls: 'turn:turn.example.com:3478?transport=tcp', username: 'nomore', credential: 'PASSWORD' },
  //   { urls: 'turns:turn.example.com:5349?transport=tcp', username: 'nomore', credential: 'PASSWORD' }
  // ]
};
