// NoMoreDiscord runtime configuration.
//
// Players on strict networks (mobile data, office wifi, CGNAT, some routers)
// cannot connect peer-to-peer with STUN alone and will sit on "Connecting"
// forever. A TURN relay fixes that, and the relay is always on: Metered hands
// out short-lived credentials at join time using the API key below, so nothing
// needs to be installed. Create a free account at
// https://dashboard.metered.ca/signup?tool=turnserver, copy the API key and
// app subdomain, and fill in the two values below.
// Voice uses roughly 50 kbps, so a few GB a month is hundreds of hours of talk.
window.NOMOREDISCORD_CONFIG = {
  // e.g. 'myteam' for https://myteam.metered.live
  meteredApp: 'nomorediscord',
  meteredApiKey: 'c40aa67681426bff38d621c01640363be739'
};
