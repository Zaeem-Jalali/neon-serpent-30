/* Registers the service worker.
 *
 * Kept in its own file rather than an inline <script> so the site can ship a
 * strict Content-Security-Policy with no 'unsafe-inline'.
 */
(function () {
  if (!("serviceWorker" in navigator)) return;

  // Service workers require a secure context. Opening index.html straight off
  // disk (file://) is still a supported way to play, so bail out quietly.
  if (location.protocol !== "https:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
    return;
  }

  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("sw.js")
      .then((registration) => {
        // When a new version takes over, reload once so the player is not left
        // running a half-updated mix of old and new files.
        let refreshing = false;
        navigator.serviceWorker.addEventListener("controllerchange", () => {
          if (refreshing) return;
          refreshing = true;
          location.reload();
        });

        registration.addEventListener("updatefound", () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            if (installing.state === "installed" && navigator.serviceWorker.controller) {
              installing.postMessage("skip-waiting");
            }
          });
        });
      })
      .catch(() => {
        // Registration failing must never stop the game from running.
      });
  });
})();
