const TechneAPI = {
  async send(method, path, body) {
    let response;
    try {
      response = await fetch(path, {
        method,
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-Techne-Client": "1" },
        body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(body || {}),
      });
    } catch {
      const error = new Error("You are offline.");
      error.offline = true;
      throw error;
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || "Request failed.");
      error.status = response.status;
      if (response.status === 401) error.unauthorized = true;
      throw error;
    }
    return data;
  },
};
