(() => {
  const waitMsg = document.getElementById("waitMsg");
  const gateMsg = document.getElementById("gateMsg");
  const gate = document.getElementById("gate");
  const unlockToggle = document.getElementById("unlockToggle");

  if (unlockToggle && gate) {
    unlockToggle.addEventListener("click", (event) => {
      event.preventDefault();
      const open = gate.classList.toggle("is-open");
      gate.hidden = !open;
      if (gateMsg) gateMsg.textContent = "";
      if (open) {
        const input = gate.querySelector('input[name="password"]');
        if (input) input.focus();
      }
    });
  }

  const waitlist = document.getElementById("waitlist");
  if (waitlist) {
    waitlist.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!waitMsg) return;
      waitMsg.className = "msg";
      waitMsg.textContent = "Saving…";
      const email = new FormData(event.currentTarget).get("email");
      try {
        const response = await fetch("/v1/waitlist", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, source: "coming-soon" }),
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error || "Could not save that email.");
        }
        waitMsg.className = "msg ok";
        waitMsg.textContent = "You're in. We'll ping you the second Replayr drops.";
        event.currentTarget.reset();
      } catch (err) {
        waitMsg.className = "msg err";
        waitMsg.textContent = err instanceof Error ? err.message : "Could not save that email.";
      }
    });
  }

  if (gate) {
    gate.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (gateMsg) {
        gateMsg.className = "msg";
        gateMsg.textContent = "Checking…";
      }
      const password = new FormData(event.currentTarget).get("password");
      try {
        const response = await fetch("/v1/site-access", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password }),
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error || "Incorrect password.");
        }
        location.assign("/");
      } catch (err) {
        if (gateMsg) {
          gateMsg.className = "msg err";
          gateMsg.textContent = err instanceof Error ? err.message : "Incorrect password.";
        }
      }
    });
  }
})();
