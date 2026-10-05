/** Fresh browser context; only synthetic session data, no provider or CLI requests. */
export async function verifyUsageBounds(page, baseURL) {
  const checks = []; let requests = 0;
  const check = (ok, label) => { if (!ok) throw Error(label); checks.push(label); };
  await page.route("**/api/arena", route => { requests++; return route.abort(); });
  await page.addInitScript(() => {
    const entry = { at: "2026-10-05T00:00:00Z", status: "success", input: Number.MAX_SAFE_INTEGER, output: 2, latencyMs: 0.25, keySource: "host" };
    sessionStorage.setItem("jev-harness-session-usage-v1", JSON.stringify([entry, entry]));
  });
  try {
    await page.goto(baseURL);
    await page.locator("#usage-open").click();
    check(await page.locator("#usage-input").textContent() === "Unknown", "overflowed reported input is shown as unknown");
    check(await page.locator("#usage-output").textContent() === "4", "independent reported output remains known");
    check(await page.locator("#usage-requests").textContent() === "2", "logical request accounting remains intact");
    check(await page.locator(".usage-price strong").textContent() === "Unknown", "no price is inferred from an unrepresentable subtotal");
    await page.getByRole("dialog", { name: "Usage & budget" }).getByText("Request history", { exact: true }).click();
    check(await page.locator("#usage-dialog tbody tr").count() === 2, "individual request measurements remain inspectable");
    check(requests === 0, "usage inspection makes no Arena request");
    return { checks, count: checks.length, providerCalls: 0, liveCliCalls: 0 };
  } finally { await page.unroute("**/api/arena"); }
}
