// NoMoreDiscord runtime configuration.
//
// Players on strict networks (mobile data, office wifi, CGNAT, some routers)
// cannot connect peer-to-peer with STUN alone and will sit on "Connecting"
// forever. A TURN relay fixes that, and the relay is always on: the free
// ExpressTurn credentials in `turnServers` below ship with the app, so nothing
// needs to be set up. Grab your own free key at https://www.expressturn.com if
// you would rather use your own quota - the credentials are visible to anyone
// using the page.
//
// Optional extra relay: Metered hands out short-lived credentials at join time.
// Create a free account at https://dashboard.metered.ca/signup?tool=turnserver,
// copy the API key and app subdomain, and fill in the two values below - or set
// them to '' to fetch nothing. Voice uses roughly 50 kbps, so a few GB a month is
// hundreds of hours of talk.
window.NOMOREDISCORD_CONFIG = {
  // e.g. 'myteam' for https://myteam.metered.live
  meteredApp: 'nomorediscord',
  meteredApiKey: 'c40aa67681426bff38d621c01640363be739',

  // The TURN relay, always on. STUN is listed first so direct paths still win;
  // the relay is only used when the direct line is blocked.
  turnServers: [
    {
      urls: [
        'turn:free.expressturn.com:3478?transport=udp',
        'turn:free.expressturn.com:3478?transport=tcp',
        'turns:free.expressturn.com:5349?transport=tcp'
      ],
      username: '000000002107824309',
      credential: 'agUEkEl21OR1968inBnAn3RzFZE='
    }
  ]
};
