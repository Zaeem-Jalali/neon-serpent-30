/* Registers the service worker and offers updates rather than forcing them.
 *
 * Kept in its own file rather than an inline <script> so the site can ship a
 * strict Content-Security-Policy with no 'unsafe-inline'.
 *
 * This used to call skip-waiting the moment a new version finished
 * installing, then reload on controllerchange — a silent, immediate update.
 * For a document that is mostly harmless; for a game it is not. A deploy
 * landing while someone was deep into a run reloaded the page underneath
 * them and destroyed the run, with no warning and no way to decline.
 *
 * Now the new version is left in the "waiting" state, the page is told about
 * it, and it activates only when the player asks. Declining costs nothing:
 * the waiting worker stays put and takes over on the next natural visit.
 */
(function () {
  if (!("serviceWorker" in navigator)) return;

  // Service workers require a secure context. Opening index.html straight off
  // disk (file://) is still a supported way to play, so bail out quietly.
  if (location.protocol !== "https:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
    return;
  }

  let reloading = false;

  // Only ever reload as a direct result of the player accepting an update.
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!reloading) return;
    location.reload();
  });

  function announce(waiting) {
    if (!waiting) return;
    window.dispatchEvent(
      new CustomEvent("sw-update-ready", {
        detail: {
          apply() {
            reloading = true;
            waiting.postMessage("skip-waiting");
          }
        }
      })
    );
  }

  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("sw.js")
      .then((registration) => {
        // A previous visit may already have left a version waiting.
        if (registration.waiting && navigator.serviceWorker.controller) {
          announce(registration.waiting);
        }

        registration.addEventListener("updatefound", () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            /* controller is null on a first-ever install: there is no
               previous version to replace, so activating immediately is
               correct and there is nothing to prompt about. */
            if (installing.state === "installed" && navigator.serviceWorker.controller) {
              announce(installing);
            }
          });
        });
      })
      .catch(() => {
        // Registration failing must never stop the game from running.
      });
  });
})();
