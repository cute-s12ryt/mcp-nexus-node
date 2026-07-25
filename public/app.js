const state = { csrfToken: "", currentView: "search", requiresSetup: false, pendingWebPath: "" };
const apiBase = window.location.pathname.replace(/\/$/, "");
let authParameterCounter = 0;
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

document.addEventListener("DOMContentLoaded", () => void initialize());

async function initialize() {
  bindEvents();
  try {
    const [status, session] = await Promise.all([api("/api/status"), api("/api/session")]);
    if (session.authenticated && session.webPath !== window.location.pathname) window.location.replace(session.webPath);
    else if (session.authenticated) enterApplication(session);
    else showAuthentication(status.requiresSetup);
  } catch (error) {
    showAuthentication(false);
    toast(`無法讀取服務狀態：${error.message}`, true);
  }
}

function bindEvents() {
  $("#auth-form").addEventListener("submit", authenticate);
  $("#logout-button").addEventListener("click", logout);
  $("#search-form").addEventListener("submit", runSearch);
  $("#orchestration-form").addEventListener("submit", saveOrchestrationSettings);
  $("#orchestration-mode").addEventListener("change", syncOrchestrationControls);
  $("#sampling-mode").addEventListener("change", syncOrchestrationControls);
  $("#web-search-mode").addEventListener("change", syncWebSearchControls);
  $$("[data-search-source]").forEach((input) => input.addEventListener("change", handleSearchSourceChange));
  $("#test-web-search").addEventListener("click", testWebSearch);
  $("#open-server-form").addEventListener("click", openServerForm);
  $("#close-server-form").addEventListener("click", () => setHidden("#server-form", true));
  $("#add-auth-parameter").addEventListener("click", () => addAuthParameterRow());
  $("#server-form").addEventListener("submit", addServer);
  $("#ai-settings-form").addEventListener("submit", saveAiSettings);
  $("#test-ai-provider").addEventListener("click", testAiProvider);
  $("#open-token-form").addEventListener("click", openTokenForm);
  $("#close-token-form").addEventListener("click", () => setHidden("#token-form", true));
  $("#token-form").addEventListener("submit", createGatewayToken);
  $("#refresh-request-logs").addEventListener("click", () => void loadRequestLogs());
  $("#rotate-web-path").addEventListener("click", rotateWebPath);
  $("#copy-token").addEventListener("click", copyToken);
  $("#close-token-dialog").addEventListener("click", closeTokenDialog);
  $$(".nav-item").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
}

function showAuthentication(requiresSetup) {
  state.requiresSetup = requiresSetup;
  setHidden("#app-view", true);
  setHidden("#auth-view", false);
  $("#auth-eyebrow").textContent = requiresSetup ? "FIRST RUN" : "管理員登入";
  $("#auth-heading").textContent = requiresSetup ? "建立唯一管理員" : "返回工作區";
  $("#auth-submit").textContent = requiresSetup ? "建立管理員" : "登入";
  $("#setup-note").hidden = !requiresSetup;
  $("#password").autocomplete = requiresSetup ? "new-password" : "current-password";
}

async function authenticate(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $("#auth-submit");
  setBusy(button, true);
  setText("#auth-error", "");
  try {
    const body = Object.fromEntries(new FormData(form));
    const result = await api(state.requiresSetup ? "/api/register" : "/api/login", { method: "POST", body });
    form.reset();
    if (result.gatewayToken) {
      state.pendingWebPath = result.webPath;
      showToken(result.gatewayToken);
    } else {
      window.location.assign(result.webPath);
    }
  } catch (error) {
    showFieldError("#auth-error", error.message);
  } finally {
    setBusy(button, false);
  }
}

function enterApplication(me) {
  state.csrfToken = me.csrfToken;
  setHidden("#auth-view", true);
  setHidden("#app-view", false);
  $("#identity-name").textContent = me.username;
  $(".avatar").textContent = me.username.slice(0, 1).toUpperCase();
  $("#web-path-value").textContent = window.location.pathname;
  void loadAiSettings();
  void loadOrchestrationSettings();
  void loadServers();
  void loadGatewayTokens();
}

async function logout() {
  try {
    await api("/api/logout", { method: "POST" });
  } catch {
    toast("伺服器工作階段已結束");
  }
  state.csrfToken = "";
  showAuthentication(false);
}

function switchView(view) {
  const metadata = {
    search: ["AI SEARCH", "搜尋工作台"],
    orchestration: ["AGENT CONTROL", "搜尋調度"],
    servers: ["MCP GATEWAY", "伺服器管理"],
    token: ["MCP AUTHENTICATION", "Gateway Token"],
    requests: ["MCP ACTIVITY", "請求紀錄"],
    settings: ["CONFIGURATION", "系統設定"],
  };
  if (!metadata[view]) return;
  state.currentView = view;
  $$(".nav-item").forEach((item) => {
    const isActive = item.dataset.view === view;
    item.classList.toggle("active", isActive);
    if (isActive) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
  $$(".view-section").forEach((section) => { section.hidden = section.id !== `${view}-section`; });
  const activeSection = $(`#${view}-section`);
  activeSection.classList.remove("view-enter");
  void activeSection.offsetWidth;
  activeSection.classList.add("view-enter");
  [$("#section-eyebrow").textContent, $("#section-title").textContent] = metadata[view];
  if (view === "token") void loadGatewayTokens();
  if (view === "requests") void loadRequestLogs();
  if (view === "orchestration") void loadOrchestrationSettings();
}

async function runSearch(event) {
  event.preventDefault();
  const button = $("#search-button");
  setBusy(button, true);
  setText("#search-status", "正在等待 Provider 回應…");
  const resultBox = $("#search-result");
  resultBox.classList.add("empty");
  resultBox.classList.add("is-loading");
  resultBox.textContent = "查詢進行中…";
  $("#agent-stages").replaceChildren();
  $("#agent-stages").hidden = true;
  $("#search-usage").hidden = true;
  $("#web-evidence").replaceChildren();
  $("#web-evidence").hidden = true;
  setText("#result-model", "執行中");
  setText("#result-mode", "Agent 調度中");
  try {
    const result = await api("/api/search", { method: "POST", body: { query: $("#search-query").value } });
    resultBox.classList.remove("empty");
    resultBox.textContent = result.answer;
    setText("#result-model", result.model);
    setText("#result-mode", orchestrationModeLabel(result.mode));
    renderAgentStages(result.stages ?? []);
    renderWebEvidence(result.webSearch);
    const usage = result.usage ?? {};
    setText("#search-usage", `Token 使用：輸入 ${formatCount(usage.promptTokens ?? 0)} · 輸出 ${formatCount(usage.completionTokens ?? 0)} · 合計 ${formatCount(usage.totalTokens ?? 0)}`);
    $("#search-usage").hidden = false;
    setText("#search-status", "查詢完成");
  } catch (error) {
    resultBox.textContent = error.message;
    setText("#result-model", "查詢失敗");
    setText("#result-mode", "調度失敗");
    setText("#search-status", "查詢失敗");
  } finally {
    resultBox.classList.remove("is-loading");
    setBusy(button, false);
  }
}

function renderAgentStages(stages) {
  const container = $("#agent-stages");
  container.replaceChildren(...stages.map((stage, index) => {
    const details = document.createElement("details");
    details.className = "agent-stage";
    details.open = index === stages.length - 1;
    const summary = document.createElement("summary");
    summary.textContent = `${index + 1}. ${stage.label}`;
    const content = document.createElement("pre");
    content.textContent = stage.content;
    details.append(summary, content);
    return details;
  }));
  container.hidden = stages.length === 0;
}

function renderWebEvidence(evidence) {
  const container = $("#web-evidence");
  const heading = document.createElement("div");
  heading.className = "evidence-heading";
  const title = document.createElement("h3");
  title.textContent = `網路證據 · ${evidence?.results?.length ?? 0} 筆`;
  const sourceTag = document.createElement("span");
  sourceTag.className = "tag";
  sourceTag.textContent = evidence?.mode === "parallel" ? "並行搜尋" : "單一搜尋";
  heading.append(title, sourceTag);
  const list = document.createElement("ol");
  list.className = "evidence-list";
  for (const item of evidence?.results ?? []) {
    const row = document.createElement("li");
    const link = document.createElement("a");
    link.href = item.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = item.title;
    const meta = document.createElement("small");
    meta.textContent = item.sources.join(" · ");
    const snippet = document.createElement("p");
    snippet.textContent = item.snippet || "沒有摘要";
    row.append(link, meta, snippet);
    list.append(row);
  }
  const failures = document.createElement("div");
  failures.className = "evidence-failures";
  for (const failure of evidence?.failures ?? []) {
    const item = document.createElement("p");
    item.textContent = `${failure.source}：${failure.error}`;
    failures.append(item);
  }
  container.replaceChildren(heading, list, failures);
  container.hidden = false;
}

async function loadOrchestrationSettings() {
  try {
    const [settings, webSearch] = await Promise.all([
      api("/api/settings/search-orchestration"),
      api("/api/settings/web-search"),
    ]);
    $("#orchestration-mode").value = settings.mode;
    $("#custom-concurrency").value = settings.customConcurrency;
    $("#history-char-limit").value = settings.historyCharLimit;
    $("#max-output-tokens").value = settings.maxOutputTokens;
    $("#sampling-mode").value = settings.samplingMode;
    $("#orchestration-temperature").value = settings.temperature;
    $("#orchestration-top-p").value = settings.topP;
    $("#planner-prompt").value = settings.plannerPrompt;
    $("#researcher-prompt").value = settings.researcherPrompt;
    $("#reviewer-prompt").value = settings.reviewerPrompt;
    $("#synthesizer-prompt").value = settings.synthesizerPrompt;
    $("#searxng-endpoint").value = webSearch.endpoint;
    $("#web-search-mode").value = webSearch.mode;
    $("#results-per-source").value = webSearch.resultsPerSource;
    $("#search-language").value = webSearch.language;
    $("#safe-search").value = String(webSearch.safeSearch);
    $$("[data-search-source]").forEach((input) => { input.checked = webSearch.sources.includes(input.value); });
    $("#web-search-status").textContent = webSearch.endpoint ? "已設定" : "尚未設定";
    $("#web-search-status").classList.toggle("success", Boolean(webSearch.endpoint));
    syncOrchestrationControls();
    syncWebSearchControls();
  } catch (error) {
    toast(error.message, true);
  }
}

function syncOrchestrationControls() {
  const mode = $("#orchestration-mode").value;
  $("#custom-concurrency").disabled = mode !== "custom";
  $("#orchestration-mode-status").textContent = orchestrationModeLabel(mode);
  const samplingMode = $("#sampling-mode").value;
  $("#temperature-field").hidden = samplingMode !== "temperature";
  $("#top-p-field").hidden = samplingMode !== "top_p";
}

function syncWebSearchControls() {
  if ($("#web-search-mode").value !== "single") return;
  const selected = $$("[data-search-source]:checked");
  selected.slice(1).forEach((input) => { input.checked = false; });
}

function handleSearchSourceChange(event) {
  const selected = $$("[data-search-source]:checked");
  if (selected.length === 0) {
    event.currentTarget.checked = true;
    return;
  }
  if ($("#web-search-mode").value === "single" && event.currentTarget.checked) {
    $$("[data-search-source]").forEach((input) => { input.checked = input === event.currentTarget; });
  }
}

async function saveOrchestrationSettings(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type=submit]");
  setBusy(button, true);
  showFieldError("#orchestration-error", "");
  try {
    const saved = await api("/api/settings/search-control", {
      method: "PUT",
      body: { orchestration: orchestrationFormValue(), webSearch: webSearchFormValue() },
    });
    $("#orchestration-mode-status").textContent = orchestrationModeLabel(saved.orchestration.mode);
    $("#web-search-status").textContent = "已設定";
    $("#web-search-status").classList.add("success");
    toast("搜尋調度設定已儲存");
  } catch (error) {
    showFieldError("#orchestration-error", error.message);
  } finally {
    setBusy(button, false);
  }
}

function orchestrationFormValue() {
  return {
    mode: $("#orchestration-mode").value,
    customConcurrency: Number($("#custom-concurrency").value),
    historyCharLimit: Number($("#history-char-limit").value),
    maxOutputTokens: Number($("#max-output-tokens").value),
    samplingMode: $("#sampling-mode").value,
    temperature: Number($("#orchestration-temperature").value),
    topP: Number($("#orchestration-top-p").value),
    plannerPrompt: $("#planner-prompt").value,
    researcherPrompt: $("#researcher-prompt").value,
    reviewerPrompt: $("#reviewer-prompt").value,
    synthesizerPrompt: $("#synthesizer-prompt").value,
  };
}

function webSearchFormValue() {
  return {
    endpoint: $("#searxng-endpoint").value,
    mode: $("#web-search-mode").value,
    sources: $$("[data-search-source]:checked").map((input) => input.value),
    resultsPerSource: Number($("#results-per-source").value),
    language: $("#search-language").value,
    safeSearch: Number($("#safe-search").value),
  };
}

async function testWebSearch() {
  const button = $("#test-web-search");
  setBusy(button, true);
  setText("#web-search-test-result", "正在測試…");
  try {
    const result = await api("/api/settings/web-search/test", { method: "POST", body: webSearchFormValue() });
    const failureText = result.failures.length ? `，${result.failures.length} 個來源失敗` : "";
    setText("#web-search-test-result", `連線成功，取得 ${result.results.length} 筆結果${failureText}`);
  } catch (error) {
    setText("#web-search-test-result", error.message);
  } finally {
    setBusy(button, false);
  }
}

function orchestrationModeLabel(mode) {
  return { precision: "高精度", parallel: "並發 5 Agent", custom: "自訂並發" }[mode] ?? "未知模式";
}

async function loadServers() {
  try {
    const servers = await api("/api/upstreams");
    const tbody = $("#server-list");
    tbody.replaceChildren(...servers.map(serverRow));
    $("#server-empty").hidden = servers.length > 0;
  } catch (error) {
    toast(error.message, true);
  }
}

function serverRow(server) {
  const row = document.createElement("tr");
  row.className = "data-row-enter";
  row.append(
    cell(server.name),
    codeCell(server.alias),
    cell(server.endpoint),
    authenticationCell(server),
    codeCell(server.exportPath),
    cell(server.enabled ? "啟用" : "停用"),
  );
  const actions = document.createElement("td");
  actions.className = "table-actions";
  const test = actionButton("測試", () => testServer(server.alias, test));
  const remove = actionButton("刪除", () => removeServer(server.id), "remove");
  actions.append(test, remove);
  row.append(actions);
  return row;
}

function authenticationCell(server) {
  const element = document.createElement("td");
  const parameters = server.authParameterSummaries ?? [];
  if (parameters.length === 0) {
    element.textContent = server.hasBearerToken ? "Bearer Token" : "無";
    if (!server.hasBearerToken) element.className = "muted";
    return element;
  }
  const list = document.createElement("div");
  list.className = "auth-summary-list";
  for (const parameter of parameters) {
    const item = document.createElement("span");
    item.className = "auth-summary";
    item.textContent = `${parameter.location === "header" ? "Header" : "Query"}: ${parameter.name}`;
    list.append(item);
  }
  element.append(list);
  return element;
}

function cell(value) {
  const element = document.createElement("td");
  element.textContent = value;
  return element;
}

function codeCell(value) {
  const element = document.createElement("td");
  const code = document.createElement("code");
  code.textContent = value;
  element.append(code);
  return element;
}

function actionButton(label, handler, className = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `mini-button ${className}`;
  button.textContent = label;
  button.addEventListener("click", handler);
  return button;
}

async function addServer(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type=submit]");
  setBusy(button, true);
  showFieldError("#server-form-error", "");
  try {
    const raw = Object.fromEntries(new FormData(form));
    const authParameters = $$("#auth-parameter-list .auth-parameter-row").map((row) => ({
      location: row.querySelector("[data-auth-location]").value,
      name: row.querySelector("[data-auth-name]").value,
      value: row.querySelector("[data-auth-value]").value,
    }));
    await api("/api/upstreams", { method: "POST", body: { ...raw, authParameters, enabled: true } });
    form.reset();
    clearAuthParameters();
    setHidden("#server-form", true);
    await loadServers();
    toast("遠端 MCP 已加入");
  } catch (error) {
    showFieldError("#server-form-error", error.message);
  } finally {
    setBusy(button, false);
  }
}

function openServerForm() {
  setHidden("#server-form", false);
  $("#server-name").focus();
}

function addAuthParameterRow() {
  const list = $("#auth-parameter-list");
  if (list.children.length >= 20) {
    toast("每個 MCP 伺服器最多可設定 20 組認證參數", true);
    return;
  }
  authParameterCounter += 1;
  const row = document.createElement("div");
  row.className = "auth-parameter-row";

  const locationId = `auth-location-${authParameterCounter}`;
  const nameId = `auth-name-${authParameterCounter}`;
  const valueId = `auth-value-${authParameterCounter}`;
  const locationField = createAuthField("傳送位置", locationId);
  const location = document.createElement("select");
  location.id = locationId;
  location.dataset.authLocation = "";
  location.append(createOption("HTTP Header", "header"), createOption("URL Query", "query"));
  locationField.append(location);

  const nameField = createAuthField("參數名稱", nameId);
  const name = document.createElement("input");
  name.id = nameId;
  name.dataset.authName = "";
  name.maxLength = 100;
  name.placeholder = "例如 Authorization 或 X-API-Key";
  name.required = true;
  nameField.append(name);

  const valueField = createAuthField("秘密值", valueId);
  const value = document.createElement("input");
  value.id = valueId;
  value.dataset.authValue = "";
  value.type = "password";
  value.autocomplete = "off";
  value.maxLength = 8000;
  value.placeholder = "例如 Bearer eyJ...";
  value.required = true;
  valueField.append(value);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "mini-button remove auth-parameter-remove";
  remove.textContent = "移除";
  remove.setAttribute("aria-label", `移除認證參數 ${authParameterCounter}`);
  remove.addEventListener("click", () => row.remove());
  row.append(locationField, nameField, valueField, remove);
  list.append(row);
}

function createAuthField(labelText, inputId) {
  const field = document.createElement("div");
  const label = document.createElement("label");
  label.htmlFor = inputId;
  label.textContent = labelText;
  field.append(label);
  return field;
}

function createOption(label, value) {
  const option = document.createElement("option");
  option.textContent = label;
  option.value = value;
  return option;
}

function clearAuthParameters() {
  $("#auth-parameter-list").replaceChildren();
}

async function testServer(alias, button) {
  setBusy(button, true);
  try {
    const result = await api(`/api/upstreams/${encodeURIComponent(alias)}/test`, { method: "POST" });
    toast(`連線成功，共 ${result.toolCount} 個工具`);
  } catch (error) {
    toast(error.message, true);
  } finally {
    setBusy(button, false);
  }
}

async function removeServer(id) {
  if (!window.confirm("確定刪除這個遠端 MCP 連線？")) return;
  try {
    await api(`/api/upstreams/${encodeURIComponent(id)}`, { method: "DELETE" });
    await loadServers();
    toast("遠端 MCP 已刪除");
  } catch (error) {
    toast(error.message, true);
  }
}

async function loadAiSettings() {
  try {
    const settings = await api("/api/settings/ai");
    $("#ai-base-url").value = settings.baseUrl;
    $("#ai-model").value = settings.model;
    $("#ai-system-prompt").value = settings.systemPrompt;
    $("#key-status").textContent = settings.hasApiKey ? "已設定" : "未設定";
    $("#key-status").classList.toggle("success", settings.hasApiKey);
  } catch (error) {
    toast(error.message, true);
  }
}

async function saveAiSettings(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type=submit]");
  setBusy(button, true);
  showFieldError("#settings-error", "");
  try {
    const body = Object.fromEntries(new FormData(event.currentTarget));
    const settings = await api("/api/settings/ai", { method: "PUT", body });
    $("#ai-api-key").value = "";
    $("#key-status").textContent = settings.hasApiKey ? "已設定" : "未設定";
    $("#key-status").classList.toggle("success", settings.hasApiKey);
    toast("AI Provider 設定已儲存");
  } catch (error) {
    showFieldError("#settings-error", error.message);
  } finally {
    setBusy(button, false);
  }
}

async function testAiProvider() {
  const button = $("#test-ai-provider");
  setBusy(button, true);
  showFieldError("#settings-error", "");
  const output = $("#ai-diagnostic");
  output.hidden = false;
  $("#diagnostic-basic").replaceChildren(statusLine("一般調用", "測試中", "pending"));
  $("#diagnostic-tools").replaceChildren(statusLine("Tool Calling 與結果回傳", "測試中", "pending"));
  setText("#diagnostic-overall", "測試中");
  $("#diagnostic-overall").classList.remove("success");
  try {
    const form = $("#ai-settings-form");
    const result = await api("/api/settings/ai/test", { method: "POST", body: Object.fromEntries(new FormData(form)) });
    renderAiDiagnostic(result);
  } catch (error) {
    setText("#diagnostic-overall", "測試失敗");
    $("#diagnostic-overall").classList.remove("success");
    $("#diagnostic-basic").replaceChildren(statusLine("診斷請求", error.message, "error"));
    $("#diagnostic-tools").replaceChildren();
  } finally {
    setBusy(button, false);
  }
}

function renderAiDiagnostic(result) {
  setText("#diagnostic-overall", result.success ? "全部通過" : "部分失敗");
  $("#diagnostic-overall").classList.toggle("success", result.success);
  const basic = document.createDocumentFragment();
  basic.append(statusLine("一般調用", result.basic.success ? "成功" : "失敗", result.basic.success ? "success" : "error"));
  appendDiagnosticValue(basic, "模型回應", result.basic.response);
  appendDiagnosticValue(basic, "原始錯誤", result.basic.rawError);
  $("#diagnostic-basic").replaceChildren(basic);

  const tools = document.createDocumentFragment();
  tools.append(statusLine("Tool Calling 與結果回傳", result.toolCalling.success ? "成功" : "失敗", result.toolCalling.success ? "success" : "error"));
  appendDiagnosticValue(tools, "工具呼叫", result.toolCalling.toolCalls && JSON.stringify(result.toolCalling.toolCalls, null, 2));
  appendDiagnosticValue(tools, "工具回傳", result.toolCalling.toolResult && JSON.stringify(result.toolCalling.toolResult, null, 2));
  appendDiagnosticValue(tools, "最終回答", result.toolCalling.finalAnswer);
  appendDiagnosticValue(tools, "原始錯誤", result.toolCalling.rawError);
  $("#diagnostic-tools").replaceChildren(tools);
}

function statusLine(label, value, stateName) {
  const line = document.createElement("div");
  line.className = "diagnostic-status";
  const heading = document.createElement("strong");
  heading.textContent = label;
  const badge = document.createElement("span");
  badge.className = `request-outcome ${stateName}`;
  badge.textContent = value;
  line.append(heading, badge);
  return line;
}

function appendDiagnosticValue(parent, label, value) {
  if (!value) return;
  const heading = document.createElement("h4");
  heading.textContent = label;
  const content = document.createElement("pre");
  content.textContent = value;
  parent.append(heading, content);
}

async function loadGatewayTokens() {
  try {
    const tokens = await api("/api/gateway-tokens");
    $("#token-list").replaceChildren(...tokens.map((token) => gatewayTokenRow(token, tokens.length === 1)));
    $("#token-empty").hidden = tokens.length > 0;
  } catch (error) {
    toast(error.message, true);
  }
}

function gatewayTokenRow(token, isFinalToken) {
  const row = document.createElement("tr");
  row.className = "data-row-enter";
  row.append(
    cell(token.name),
    maskedTokenCell(token.tokenSuffix),
    cell(formatCount(token.requestCount)),
    cell(formatCount(token.successfulToolCalls)),
    cell(token.lastUsedAt ? formatDate(token.lastUsedAt) : "尚未使用"),
  );
  const actions = document.createElement("td");
  actions.className = "table-actions";
  const revoke = actionButton("撤銷", () => revokeGatewayToken(token), "remove");
  revoke.disabled = isFinalToken;
  if (isFinalToken) revoke.title = "至少需要保留一組 Gateway Token";
  actions.append(revoke);
  row.append(actions);
  return row;
}

function maskedTokenCell(suffix) {
  const element = document.createElement("td");
  const code = document.createElement("code");
  code.className = "masked-token";
  code.textContent = suffix ? `•••••${suffix}` : "舊資料無法還原";
  element.append(code);
  return element;
}

function openTokenForm() {
  setHidden("#token-form", false);
  $("#token-name").focus();
}

async function createGatewayToken(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type=submit]");
  setBusy(button, true);
  showFieldError("#token-form-error", "");
  try {
    const result = await api("/api/gateway-tokens", {
      method: "POST",
      body: Object.fromEntries(new FormData(form)),
    });
    form.reset();
    setHidden("#token-form", true);
    await loadGatewayTokens();
    showToken(result.gatewayToken, result.token.name);
  } catch (error) {
    showFieldError("#token-form-error", error.message);
  } finally {
    setBusy(button, false);
  }
}

async function revokeGatewayToken(token) {
  if (!window.confirm(`確定撤銷「${token.name}」？使用這組 Token 的既有 MCP session 會立即中斷。`)) return;
  try {
    await api(`/api/gateway-tokens/${encodeURIComponent(token.id)}`, { method: "DELETE" });
    await loadGatewayTokens();
    toast("Gateway Token 已撤銷");
  } catch (error) {
    toast(error.message, true);
  }
}

async function loadRequestLogs() {
  const button = $("#refresh-request-logs");
  setBusy(button, true);
  try {
    const logs = await api("/api/request-logs");
    $("#request-log-list").replaceChildren(...logs.map(requestLogRow));
    $("#request-log-empty").hidden = logs.length > 0;
  } catch (error) {
    toast(error.message, true);
  } finally {
    setBusy(button, false);
  }
}

function requestLogRow(log) {
  const row = document.createElement("tr");
  row.className = "data-row-enter";
  row.append(
    cell(formatDate(log.timestamp)),
    cell(`${log.tokenName} · ${log.tokenSuffix ? `•••••${log.tokenSuffix}` : "舊 Token"}`),
    codeCell(log.endpoint),
    codeCell(log.method),
    outcomeCell(log),
  );
  return row;
}

function outcomeCell(log) {
  const element = document.createElement("td");
  const badge = document.createElement("span");
  badge.className = `request-outcome ${log.outcome}`;
  badge.textContent = `${log.outcome === "success" ? "成功" : "失敗"} · ${log.status}`;
  element.append(badge);
  return element;
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "未知" : new Intl.DateTimeFormat("zh-TW", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).format(date);
}

function formatCount(value) {
  return new Intl.NumberFormat("zh-TW").format(value);
}

async function rotateWebPath() {
  if (!window.confirm("刷新後，目前的 Web 控制台網址會立即失效。確定繼續？")) return;
  const button = $("#rotate-web-path");
  setBusy(button, true);
  try {
    const result = await api("/api/web-path/rotate", { method: "POST" });
    window.location.replace(result.webPath);
  } catch (error) {
    toast(error.message, true);
    setBusy(button, false);
  }
}

function showToken(token, name = "Gateway Token") {
  $("#token-value").textContent = token;
  $("#token-dialog-title").textContent = `立即保存「${name}」`;
  setHidden("#token-dialog", false);
  $("#copy-token").focus();
}

function closeTokenDialog() {
  setHidden("#token-dialog", true);
  $("#token-value").textContent = "";
  $("#token-dialog-title").textContent = "立即保存 Gateway Token";
  if (state.pendingWebPath) window.location.assign(state.pendingWebPath);
}

async function copyToken() {
  try {
    await navigator.clipboard.writeText($("#token-value").textContent);
    toast("Token 已複製");
  } catch {
    toast("無法存取剪貼簿，請手動選取 Token", true);
  }
}

async function api(path, options = {}) {
  const headers = { Accept: "application/json", ...options.headers };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (state.csrfToken && options.method && options.method !== "GET") headers["X-CSRF-Token"] = state.csrfToken;
  const response = await fetch(`${apiBase}${path}`, { ...options, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  if (response.status === 204) return undefined;
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && data.loginPath) {
    window.location.assign(data.loginPath);
  }
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function setBusy(button, busy) {
  button.disabled = busy;
  button.setAttribute("aria-busy", String(busy));
}

function setHidden(selector, hidden) { $(selector).hidden = hidden; }
function setText(selector, text) { $(selector).textContent = text; }
function showFieldError(selector, message) { const target = $(selector); target.textContent = message; target.hidden = !message; }

let toastTimer;
let toastHideTimer;
function toast(message, isError = false) {
  const element = $("#toast");
  clearTimeout(toastTimer);
  clearTimeout(toastHideTimer);
  element.textContent = message;
  element.classList.toggle("error", isError);
  element.classList.remove("is-leaving", "is-visible");
  element.hidden = false;
  void element.offsetWidth;
  element.classList.add("is-visible");
  toastTimer = setTimeout(() => {
    element.classList.remove("is-visible");
    element.classList.add("is-leaving");
    toastHideTimer = setTimeout(() => {
      element.hidden = true;
      element.classList.remove("is-leaving");
    }, 180);
  }, 4500);
}
