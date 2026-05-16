window.LILY_API_BASE = ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname)
  ? ""
  : "https://lily-api-production.up.railway.app";
