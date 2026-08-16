"use strict";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function isLoopbackHost(hostname) {
  return LOOPBACK_HOSTS.has(String(hostname).toLowerCase());
}

// Binds the server, walking upward from the requested port when it is already
// taken. Port 0 asks the operating system for any free port, which is the
// behaviour Foundry Local itself uses.
function listenWithFallback(server, { host, port, portSearchLimit }) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    let current = port;

    const onError = error => {
      if (error.code !== "EADDRINUSE" || port === 0 || attempt >= portSearchLimit) {
        server.removeListener("listening", onListening);
        if (error.code === "EADDRINUSE") {
          return reject(new Error(
            `Port ${current} is in use and no free port was found within ${portSearchLimit} attempts. ` +
            'Set "web.port" to 0 in config.json to let the operating system assign one.'
          ));
        }
        return reject(error);
      }
      attempt += 1;
      current += 1;
      server.listen(current, host);
    };

    const onListening = () => {
      server.removeListener("error", onError);
      const address = server.address();
      resolve({ host, port: address.port, reassigned: port !== 0 && address.port !== port });
    };

    server.on("error", onError);
    server.once("listening", onListening);
    server.listen(current, host);
  });
}

module.exports = { isLoopbackHost, listenWithFallback };
