const { startServer } = require('./static-server');

const PORT = Number(process.env.PORT || 8787);

startServer(PORT)
  .then((site) => {
    console.log(`NoMoreDiscord running at ${site.origin}`);
    console.log('Open the same URL in two windows with the same ?room= to test a mesh.');
    console.log('Mic capture is allowed on localhost. Press Ctrl+C to stop.');
  })
  .catch((error) => {
    console.error(`Could not start on port ${PORT}: ${error.message}`);
    process.exit(1);
  });