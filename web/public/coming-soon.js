(() => {
  const waitMsg = document.getElementById("waitMsg");
  const waitConfirm = document.getElementById("waitConfirm");
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
        gate.scrollIntoView({ block: "nearest" });
      }
    });
  }

  const waitlistForms = document.querySelectorAll("form.waitlist");
  waitlistForms.forEach((waitlist) => {
    waitlist.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!waitMsg) return;
      waitMsg.className = "msg";
      waitMsg.textContent = "Saving…";
      if (waitConfirm) waitConfirm.classList.remove("is-open");
      const form = event.currentTarget instanceof HTMLFormElement ? event.currentTarget : waitlist;
      const email = new FormData(form).get("email");
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
        waitlistForms.forEach((node) => {
          node.classList.add("is-done");
          if (node instanceof HTMLFormElement) node.reset();
        });
        waitMsg.className = "msg";
        waitMsg.textContent = "";
        if (waitConfirm) {
          waitConfirm.classList.add("is-open");
          waitConfirm.scrollIntoView({ block: "nearest" });
        }
      } catch (err) {
        waitMsg.className = "msg err";
        waitMsg.textContent = err instanceof Error ? err.message : "Could not save that email.";
      }
    });
  });

  if (gate) {
    gate.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (gateMsg) {
        gateMsg.className = "msg";
        gateMsg.textContent = "Checking…";
      }
      const form = event.currentTarget instanceof HTMLFormElement ? event.currentTarget : gate;
      const password = new FormData(form).get("password");
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

  const presenceAidKey = "replayr_aid";
  let presenceId = "";
  try {
    presenceId = localStorage.getItem(presenceAidKey) || "";
    if (presenceId.length < 8) {
      presenceId = crypto.randomUUID();
      localStorage.setItem(presenceAidKey, presenceId);
    }
  } catch {
    presenceId = "anonwait" + String(Date.now());
  }
  const pingPresence = () => {
    if (document.visibilityState === "hidden") return;
    void fetch("/v1/presence/ping", {
      method: "POST",
      headers: { "content-type": "application/json" },
      keepalive: true,
      body: JSON.stringify({ path: "/coming-soon", anonymousId: presenceId, surface: "coming-soon" }),
    }).catch(() => undefined);
  };
  pingPresence();
  window.setInterval(pingPresence, 25000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") pingPresence();
  });
})();
