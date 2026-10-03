import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, extname, sep } from "node:path";
import { chromium, expect } from "../../../../../modera-app/node_modules/@playwright/test/index.mjs";

const root = fileURLToPath(new URL("../../dist/ui/", import.meta.url));
const artifacts = fileURLToPath(new URL("../../../../artifacts/kanban-ui/", import.meta.url));
const now = Date.UTC(2026, 9, 2, 9);
const role = (id, name) => ({ id, name, description: `${name} role`, prompt: `Perform ${name} work.`, enabled: true, tools: "inherit" });
const task = (id, number, status, extra = {}) => ({ id, number, status, projectId: "project-1", title: ["Clarify export requirements", "Repair CSV escaping", "Audit keyboard navigation", "Review delivery evidence", "Ship locale coverage", "Resolve API contract", "Close obsolete investigation"][number - 1] ?? `Task ${number}`, description: "Preserve the original requirement.\nVerify the resulting behavior.", originalDescription: "Preserve the original requirement.\nVerify the resulting behavior.", type: "requirement", priority: "normal", labels: ["product"], assigneeId: "worker", reviewerId: "reviewer", dependencyIds: [], iteration: "Sprint 8", milestone: "October", acceptanceCriteria: ["Data is preserved", "Keyboard controls work"], automatic: false, archived: false, createdAt: now, updatedAt: now, revision: 7, runs: [], comments: [], activity: [], ...extra });
const delivery = { id: "run-review", phase: "execution", state: "completed", roleId: "worker", roleName: "Executor", runId: "host-run", target: { projectId: "project-1", sessionId: "session-1", selection: { profileId: "local", model: "model-a", reasoningEffort: "medium" } }, startedAt: now, finishedAt: now + 15000, summary: "Delivery completed with verified behavior.", verdict: "ready_for_review", evidence: [{ label: "Unit tests", result: "passed", details: "12 checks passed" }, { label: "Mobile check", result: "failed", details: "A row overflows" }, { label: "Deployment", result: "not_run", details: "Not requested" }], artifacts: [{ title: "Export implementation", path: "src/export.ts" }] };
const analysis = { goal: "Deliver a reliable export", scope: "CSV only", acceptanceCriteria: ["Quotes are escaped"], questions: [], subtasks: [{ title: "Add regression coverage", description: "Cover embedded quotes", acceptanceCriteria: ["Round-trip succeeds"] }] };
const fixture = { projectId: "project-1", projects: [{ id: "project-1", name: "Modera workspace" }], executionAvailable: true, isolatedWorkspaces: true, models: [{ profileId: "local", name: "Local", models: ["model-a", "model-b"], efforts: { "model-a": ["low", "medium", "high"], "model-b": ["none", "low"] } }], settings: { projectId: "project-1", autoExecute: false, autoReview: false, maxConcurrent: 1, analyzerId: "explorer", defaultAssigneeId: "worker", defaultReviewerId: "reviewer" }, catalog: { revision: 3, roles: [role("explorer", "Analyzer"), role("worker", "Executor"), role("reviewer", "Reviewer")], templates: [role("researcher", "Researcher")], options: { tools: [{ id: "files.read", title: "Read files" }, { id: "files.write", title: "Write files" }], models: [{ profileId: "local", name: "Local", models: ["model-a", "model-b"] }] } }, tasks: [task("backlog", 1, "backlog"), task("todo", 2, "todo", { type: "bug", priority: "urgent", labels: ["product", "csv"] }), task("running", 3, "in_progress", { activeRunId: "live", runs: [{ ...delivery, id: "live", state: "running", finishedAt: undefined }] }), task("review", 4, "in_review", { priority: "high", analysis, runs: [delivery], comments: [{ id: "comment-1", text: "Please check the export.", author: "user", createdAt: now }], activity: [{ id: "activity-1", kind: "result", text: "Execution completed", createdAt: now }] }), task("done", 5, "done", { type: "document", priority: "low" }), task("unresolved", 6, "blocked", { activeRunId: "unresolved-run", blockReason: "Previous execution is unresolved", runs: [{ ...delivery, id: "unresolved-run", state: "interrupted", finishedAt: undefined }] }), task("cancelled", 7, "cancelled"), task("archived", 8, "todo", { archived: true })] };
await mkdir(artifacts, { recursive: true });
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const path = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    assert.ok(path.startsWith(resolve(root) + sep));
    response.setHeader("Content-Type", ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" })[extname(path)] ?? "application/octet-stream");
    response.end(await readFile(path));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "chrome", headless: true });
const failures = [];
let page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
page.on("pageerror", error => failures.push(String(error)));
page.setDefaultTimeout(6000);
let checks = 0;
async function load({ locale = "en", theme = "light", data = fixture, failLoad = false, loading = false } = {}) {
  const viewport = page.viewportSize();
  await page.close();
  page = await browser.newPage({ viewport, reducedMotion: "reduce" });
  page.on("pageerror", error => failures.push(String(error)));
  page.setDefaultTimeout(6000);
  await page.addInitScript(({ data, locale, theme, failLoad, loading }) => {
    window.__data = structuredClone(data); window.__actions = []; window.__navigation = []; window.__failure = "";
    const listeners = new Set(), themeListeners = new Set();
    window.__theme = { mode: theme, accent: "#3978f6", colors: {} };
    const snapshot = () => structuredClone({ locale, slot: "workbench", view: { data: window.__data, children: [] }, theme: window.__theme });
    window.__emit = () => listeners.forEach(listener => listener());
    window.__setTheme = next => { window.__theme = next; themeListeners.forEach(listener => listener(next)); };
    window.moderaPlugin = {
      ready: async () => {}, snapshot: async () => { if (loading) return new Promise(() => {}); if (failLoad) throw Error("Snapshot unavailable"); return snapshot(); },
      onChanged: listener => { listeners.add(listener); return () => listeners.delete(listener); },
      onThemeChanged: listener => { themeListeners.add(listener); return () => themeListeners.delete(listener); },
      openConversation: async id => { if (window.__navigationFailure) throw Error(window.__navigationFailure); window.__navigation.push({ kind: "conversation", id }); },
      openFile: async id => { window.__navigation.push({ kind: "file", id }); }, copyText: async id => { window.__navigation.push({ kind: "copy", id }); },
      openSettings: async () => { window.__navigation.push({ kind: "settings" }); },
      action: async (id, raw) => {
        const payload = id === "project" ? raw : JSON.parse(raw ?? "{}");
        window.__actions.push({ id, payload });
        if (window.__failure) throw Error(window.__failure);
        if (id === "stop" && window.__holdStop) await new Promise(resolve => { window.__releaseStop = resolve; });
        const data = window.__data, task = data.tasks.find(task => task.id === payload.id);
        if (id === "move") { task.status = payload.status; task.revision++; }
        if (id === "edit") { Object.assign(task, payload); task.revision++; }
        if (id === "create") data.tasks.push({ ...payload, id: "created", number: 9, projectId: data.projectId, archived: false, revision: 1, createdAt: Date.now(), updatedAt: Date.now(), runs: [], comments: [], activity: [] });
        if (id === "comment") task.comments.push({ id: "new-comment", text: payload.text, author: "user", createdAt: Date.now() });
        if (id === "accept") { task.status = "done"; task.revision++; }
        if (id === "rework") { task.status = "todo"; task.revision++; }
        if (id === "archive" || id === "restore") { task.archived = id === "archive"; task.revision++; }
        if (id === "delete") data.tasks = data.tasks.filter(task => task.id !== payload.id);
        if (id === "settings") data.settings = payload;
        if (id === "saveRole") { data.catalog.roles = [...data.catalog.roles.filter(role => role.id !== payload.role.id), payload.role]; data.catalog.revision++; }
        if (id === "removeRole") { data.catalog.roles = data.catalog.roles.filter(role => role.id !== payload.id); data.catalog.revision++; }
        if (!window.__suppressEvents) window.__emit(); return snapshot();
      },
    };
  }, { data, locale, theme, failLoad, loading });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  if (!loading && !failLoad) await expect(page.locator(".kb-project-name")).toBeVisible();
}
async function choose(label, option, scope = page) {
  await scope.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: false }).click();
}
const lastAction = () => page.evaluate(() => window.__actions.at(-1));
const expectAction = async (id, payload) => { await expect.poll(lastAction).toEqual({ id, payload }); checks++; };
const detail = () => page.locator(".kb-detail-dialog");
const open = async id => { await page.locator(`.kb-task-main[aria-label*="#${fixture.tasks.find(task => task.id === id).number}"]`).click(); await expect(detail()).toBeVisible(); };
const menu = async option => { await detail().getByRole("button", { name: "Task management", exact: true }).click(); await page.getByRole("menuitem", { name: option, exact: true }).click(); };
async function screenshot(name) { await page.screenshot({ path: resolve(artifacts, `${name}.png`), fullPage: true }); }
async function noPageOverflow() {
  const layout = await page.evaluate(() => ({ width: innerWidth, page: document.documentElement.scrollWidth, styles: [...document.querySelectorAll(".kb-scope,.kb-page,.kb-workspace,.kb-board")].map(node => ({ class: node.className, width: node.clientWidth, scroll: node.scrollWidth, overflow: getComputedStyle(node).overflow, position: getComputedStyle(node).position })), outside: [...document.querySelectorAll(".kb-header,.kb-heading,.kb-toolbar,.kb-filters,.kb-workspace,.mu-choice-field,.mu-choice-trigger")].map(node => ({ class: node.className, left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right })).filter(item => item.left < 0 || item.right > innerWidth) }));
  if (layout.page > layout.width) await screenshot(`overflow-${layout.width}`);
  assert.ok(layout.page <= layout.width, JSON.stringify(layout)); checks++;
}
try {
  for (const width of [390, 900, 1440]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await load(); await noPageOverflow(); await screenshot(`board-${width}`);
    await page.getByRole("tab", { name: "List", exact: true }).click();
    await expect(page.getByRole("table")).toBeVisible(); await noPageOverflow(); await screenshot(`list-${width}`);
    await page.getByRole("button", { name: "New task", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "New task" })).toBeVisible(); await noPageOverflow(); await screenshot(`editor-${width}`);
    await page.keyboard.press("Escape");
  }
  await page.setViewportSize({ width: 1440, height: 1000 }); await load();
  await page.getByRole("textbox", { name: "Search tasks" }).fill("CSV"); await expect(page.locator(".kb-task")).toHaveCount(1);
  await page.getByRole("button", { name: "Clear filters" }).click();
  for (const [label, option] of [["Type", "Bug"], ["Priority", "Urgent"], ["Assignee", "Executor"], ["Iteration", "Sprint 8"], ["Labels", "csv"]]) {
    await choose(label, option); await page.keyboard.press("Escape");
  }
  await expect(page.locator(".kb-task")).toHaveCount(1); checks++;
  await page.getByRole("button", { name: "Clear filters" }).click();
  await page.getByRole("button", { name: "Archived tasks" }).click(); await expect(page.locator(".kb-task")).toHaveCount(1); checks++;
  await page.getByRole("button", { name: "Archived tasks" }).click();
  await choose("Task #2 status", "Backlog"); await expectAction("move", { id: "todo", revision: 7, status: "backlog" });
  const card = page.locator(".kb-task").filter({ has: page.getByRole("button", { name: "View task #1: Clarify export requirements" }) });
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await card.dispatchEvent("dragstart", { dataTransfer: transfer });
  const column = page.getByRole("region", { name: "To do", exact: true });
  await column.dispatchEvent("dragover", { dataTransfer: transfer }); await column.dispatchEvent("drop", { dataTransfer: transfer });
  await expectAction("move", { id: "backlog", revision: 7, status: "todo" });
  await page.getByRole("button", { name: "New task", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "New task" });
  await editor.getByRole("textbox", { name: "Title", exact: true }).fill("Add export regression");
  await editor.getByRole("textbox", { name: "Raw requirement" }).fill("Escaped quotes must round-trip.");
  await editor.getByRole("textbox", { name: "Labels", exact: true }).fill("csv, coverage");
  await editor.getByRole("textbox", { name: "Acceptance criteria" }).fill("Quotes survive\nTests pass");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expectAction("create", { title: "Add export regression", description: "Escaped quotes must round-trip.", type: "requirement", priority: "normal", status: "backlog", labels: ["coverage", "csv"], assigneeId: "worker", reviewerId: "reviewer", dependencyIds: [], iteration: "", milestone: "", acceptanceCriteria: ["Quotes survive", "Tests pass"], automatic: false });
  await open("review"); await screenshot("detail-1440");
  await expect(detail().getByText("CSV only", { exact: true })).toBeVisible();
  await detail().getByRole("tab", { name: /^Runs/ }).click();
  await expect(detail().getByText("12 checks passed")).toBeVisible();
  await expect(detail().getByText("A row overflows")).toBeVisible();
  await expect(detail().getByText("Not requested", { exact: true })).toBeVisible(); checks++;
  await detail().getByRole("button", { name: "Open run conversation" }).click();
  await detail().getByRole("button", { name: /Export implementation/ }).click();
  assert.deepEqual(await page.evaluate(() => window.__navigation), [{ kind: "conversation", id: "session-1" }, { kind: "file", id: "src/export.ts" }]); checks++;
  await detail().getByRole("tab", { name: /^Comments/ }).click();
  await detail().getByRole("textbox", { name: "Add comment" }).fill("Verified export behavior.");
  await detail().getByRole("button", { name: "Send", exact: true }).click(); await expectAction("comment", { id: "review", text: "Verified export behavior." });
  await detail().getByRole("tab", { name: /^Activity/ }).click(); await expect(detail().getByText("Execution completed", { exact: true })).toBeVisible(); checks++;
  await detail().getByRole("button", { name: "Accept", exact: true }).click(); await expectAction("accept", { id: "review", revision: 7 });
  await page.keyboard.press("Escape"); await load(); await open("review");
  await detail().getByRole("button", { name: "Request rework", exact: true }).click();
  const rework = page.getByRole("dialog", { name: "Request rework", exact: true });
  await rework.getByRole("textbox", { name: "Rework instructions" }).fill("Fix the mobile row.");
  await rework.getByRole("button", { name: "Submit", exact: true }).click(); await expectAction("rework", { id: "review", revision: 7, text: "Fix the mobile row." });
  await page.keyboard.press("Escape"); await load(); await open("todo"); await menu("Edit task");
  const edit = page.getByRole("dialog", { name: "Edit task", exact: true });
  await edit.getByRole("textbox", { name: "Raw requirement" }).fill("Clarified requirement.");
  await edit.getByRole("button", { name: "Save", exact: true }).click();
  const edited = await lastAction(); assert.equal(edited.id, "edit"); assert.equal(edited.payload.revision, 7); assert.equal(edited.payload.description, "Clarified requirement."); checks++;
  await page.keyboard.press("Escape"); await load();
  const runningCard = page.locator(".kb-task").filter({has: page.getByRole("button", {name: "View task #3: Audit keyboard navigation", exact: true})});
  const runningConversation = runningCard.getByRole("button", {name: "Open task conversation", exact: true});
  await expect(runningConversation).toHaveClass(/mu-button-primary/);
  await runningConversation.click();
  assert.deepEqual(await page.evaluate(() => window.__navigation), [{kind: "conversation", id: "session-1"}]);
  assert.deepEqual(await page.evaluate(() => window.__actions), []);
  await expect(detail()).toHaveCount(0); checks++;
  await open("running");
  await expect(detail().getByRole("button", { name: "Analyze", exact: true })).toBeDisabled();
  await detail().getByRole("button", { name: "Task management", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Edit task", exact: true })).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: "Delete task", exact: true })).toBeDisabled(); checks++;
  await page.keyboard.press("Escape"); await detail().getByRole("button", { name: "Stop", exact: true }).click(); await expectAction("stop", { id: "running", revision: 7 });
  await page.keyboard.press("Escape"); await load(); await open("unresolved");
  await detail().getByRole("button", { name: "Retry", exact: true }).click();
  const recovery = page.getByRole("dialog", { name: "Confirm previous execution", exact: true });
  await expect(recovery.getByRole("button", { name: "Confirm and run", exact: true })).toBeDisabled();
  await expect(recovery.getByRole("switch")).toBeDisabled();
  await recovery.getByRole("button", { name: "Open run conversation" }).click();
  await recovery.getByRole("switch").click(); await recovery.getByRole("button", { name: "Confirm and run", exact: true }).click(); await expectAction("retry", { id: "unresolved", revision: 7 });
  await page.keyboard.press("Escape"); await load();
  await page.getByRole("button", { name: "Board settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Board settings" });
  await settings.getByRole("switch", { name: "Auto execute", exact: true }).click();
  await settings.getByRole("switch", { name: "Auto review", exact: true }).click();
  await choose("Model", "model-b", settings); await choose("Reasoning", "Low", settings);
  await settings.getByRole("spinbutton", { name: "Max concurrent runs" }).fill("4");
  await settings.getByRole("button", { name: "Save", exact: true }).click();
  await expectAction("settings", { ...fixture.settings, autoExecute: true, autoReview: true, maxConcurrent: 4, selection: { profileId: "local", model: "model-b", reasoningEffort: "low" } });
  await page.getByRole("button", { name: "Roles", exact: true }).click();
  const manager = page.getByRole("dialog", { name: "Roles", exact: true });
  await manager.getByRole("button", { name: "New role", exact: true }).click();
  await manager.getByRole("textbox", { name: "Name", exact: true }).fill("Verifier");
  await manager.getByRole("textbox", { name: "ID", exact: true }).fill("verifier");
  await manager.getByRole("textbox", { name: "Description", exact: true }).fill("Checks delivery");
  await manager.getByRole("textbox", { name: "Prompt", exact: true }).fill("Inspect evidence and report findings.");
  await choose("Tool policy", "Custom tools", manager);
  await choose("Tools", "Read files", manager);
  if (await page.locator(".mu-choice-content").count()) await page.keyboard.press("Escape");
  await manager.getByRole("spinbutton", { name: "Max steps", exact: true }).fill("20");
  await manager.getByRole("button", { name: "Save role", exact: true }).click();
  await expectAction("saveRole", { revision: 3, role: { id: "verifier", name: "Verifier", description: "Checks delivery", prompt: "Inspect evidence and report findings.", enabled: true, tools: ["files.read"], limits: { maxSteps: 20 } } });
  await manager.getByRole("button", { name: "Remove Verifier", exact: true }).click();
  await page.getByRole("dialog", { name: "Remove role" }).getByRole("button", { name: "Remove", exact: true }).click(); await expectAction("removeRole", { revision: 4, id: "verifier" });
  for (const [policy, expected] of [["Default read-only tools", undefined], ["Inherit available tools", "inherit"], ["Custom tools", []]]) {
    await load(); await page.getByRole("button", { name: "Roles", exact: true }).click();
    const manager = page.getByRole("dialog", { name: "Roles", exact: true });
    await manager.getByRole("button", { name: "Edit Executor", exact: true }).click();
    await choose("Tool policy", policy, manager);
    await manager.getByRole("button", { name: "Save role", exact: true }).click();
    const result = await lastAction(); assert.equal(result.id, "saveRole"); assert.equal(result.payload.revision, 3);
    assert.deepEqual(result.payload.role.tools, expected);
    if (expected === undefined) assert.equal(Object.hasOwn(result.payload.role, "tools"), false);
    checks++;
  }
  for (const status of ["backlog", "todo"]) {
    await load({ data: { ...fixture, settings: { ...fixture.settings, autoExecute: true } } });
    await page.getByRole("button", { name: `New task in ${status === "todo" ? "To do" : "Backlog"}`, exact: true }).click();
    const editor = page.getByRole("dialog", { name: "New task", exact: true });
    await expect(editor.getByRole("combobox", { name: "Status", exact: true })).toHaveAttribute("placeholder", status === "todo" ? "To do" : "Backlog");
    await expect(editor.getByRole("switch", { name: "Automatic execution", exact: true })).toBeChecked();
    await editor.getByRole("textbox", { name: "Title", exact: true }).fill(`Create in ${status}`);
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    assert.equal((await lastAction()).payload.status, status); checks++;
  }
  await load({ data: { ...fixture, isolatedWorkspaces: false, settings: { ...fixture.settings, maxConcurrent: 4 } } });
  await page.getByRole("button", { name: "Board settings", exact: true }).click();
  const serialSettings = page.getByRole("dialog", { name: "Board settings", exact: true });
  await expect(serialSettings.getByRole("spinbutton", { name: "Max concurrent runs" })).toBeDisabled();
  await expect(serialSettings.getByRole("spinbutton", { name: "Max concurrent runs" })).toHaveValue("1");
  await serialSettings.getByRole("button", { name: "Save", exact: true }).click();
  await expectAction("settings", { ...fixture.settings, maxConcurrent: 1 });
  await load({ data: { ...fixture, tasks: fixture.tasks.map(item => item.id === "todo" ? { ...item, description: "Clarified requirement with answers." } : item) } });
  await open("todo");
  await expect(detail().getByRole("heading", { name: "Original requirement", exact: true })).toBeVisible();
  await expect(detail().getByText("Clarified requirement with answers.", { exact: true })).toBeVisible();
  await expect(detail().getByText("Preserve the original requirement.\nVerify the resulting behavior.", { exact: true })).toBeVisible(); checks++;
  for (const [id, taskId, button] of [["analyze", "todo", "Analyze"], ["start", "todo", "Start"], ["review", "review", "Review"]]) {
    await load(); await open(taskId); await detail().getByRole("button", { name: button, exact: true }).click();
    await expectAction(id, { id: taskId, revision: 7 });
  }
  await load(); await open("review"); await menu("Split subtasks"); await expectAction("split", { id: "review", revision: 7 });
  await load(); await open("todo"); await menu("Archive task"); await expectAction("archive", { id: "todo", revision: 7 });
  await menu("Restore task"); await expectAction("restore", { id: "todo", revision: 8 });
  await menu("Delete task");
  await page.getByRole("dialog", { name: "Delete task", exact: true }).getByRole("button", { name: "Delete", exact: true }).click();
  await expectAction("delete", { id: "todo", revision: 9 });
  await load(); await open("unresolved"); await detail().getByRole("button", { name: "Continue", exact: true }).click();
  const continuation = page.getByRole("dialog", { name: "Confirm previous execution", exact: true });
  await continuation.getByRole("button", { name: "Open run conversation", exact: true }).click();
  await continuation.getByRole("switch").click(); await continuation.getByRole("button", { name: "Confirm and run", exact: true }).click();
  await expectAction("continue", { id: "unresolved", revision: 7 });
  await load();
  await page.evaluate(() => { window.__failure = "Task changed; refresh and retry"; window.__suppressEvents = true; });
  await page.getByRole("button", { name: "New task", exact: true }).click();
  const retained = page.getByRole("dialog", { name: "New task", exact: true });
  await retained.getByRole("textbox", { name: "Title", exact: true }).fill("Retain this draft");
  await retained.getByRole("button", { name: "Save", exact: true }).click();
  await expect(retained.getByRole("alert")).toContainText("Task changed");
  await expect(retained.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Retain this draft");
  await page.evaluate(() => { window.__failure = ""; });
  await retained.getByRole("button", { name: "Save", exact: true }).click();
  await expect(retained).toBeHidden(); await expect(page.getByRole("button", { name: "View task #9: Retain this draft", exact: true })).toBeVisible(); checks++;
  await load({ data: { ...fixture, models: [], error: "No model profile is configured" } });
  await expect(page.getByRole("alert")).toContainText("No model profile is configured");
  await page.getByRole("button", { name: "Configure model", exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.__navigation), [{ kind: "settings" }]);
  await page.getByRole("button", { name: "Board settings", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Board settings", exact: true }).getByRole("combobox", { name: "Model", exact: true })).toBeVisible(); checks++;
  for (const width of [390, 900]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 }); await load(); await open("review");
    await noPageOverflow(); await screenshot(`detail-${width}`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.keyboard.press("Escape"); await load();
  await page.evaluate(() => { window.__failure = "Task changed; refresh and retry"; });
  await choose("Task #2 status", "Backlog"); await expect(page.getByRole("alert")).toContainText("Task changed"); checks++;
  await load({ locale: "zh-CN", theme: "dark" }); await noPageOverflow(); await screenshot("board-zh-dark-1440");
  await page.evaluate(() => window.__setTheme({ mode: "light", accent: "#168357", colors: { page: "#fafafa", ink: "#202020" } }));
  await expect(page.locator(".kb-scope")).toHaveAttribute("data-theme", "light");
  assert.equal(await page.locator(".kb-scope").evaluate(node => getComputedStyle(node).getPropertyValue("--mu-page").trim()), "#fafafa"); checks++;
  await load({ data: { ...fixture, tasks: [] } });
  await expect(page.locator(".kb-column")).toHaveCount(7);
  await expect(page.getByRole("button", { name: "New task in To do", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "New task in To do", exact: true }).click();
  const firstTask = page.getByRole("dialog", { name: "New task", exact: true });
  await expect(firstTask.getByRole("combobox", { name: "Status", exact: true })).toHaveAttribute("placeholder", "To do");
  await firstTask.getByRole("textbox", { name: "Title", exact: true }).fill("First task from Todo");
  await firstTask.getByRole("button", { name: "Save", exact: true }).click();
  assert.equal((await lastAction()).payload.status, "todo"); checks++;
  await load({ data: { ...fixture, tasks: [] } });
  await page.getByRole("tab", { name: "List", exact: true }).click();
  await expect(page.getByText("No tasks yet", { exact: true })).toBeVisible(); checks++;
  const question = "请确认仅处理 generated-output/test 目录，保留项目源码、配置和 README.md。";
  const waitingRun = { ...delivery, id: "analysis-question", phase: "analysis", state: "running", finishedAt: undefined, waitingForInput: true, summary: undefined, verdict: undefined, evidence: undefined, artifacts: undefined, target: {...delivery.target, sessionId: "original-task-session"} };
  const waiting = task("todo", 2, "in_progress", { activeRunId: waitingRun.id, analysis: {...analysis, questions: [question]}, runs: [delivery, waitingRun] });
  for (const width of [390, 900, 1440]) {
    await page.setViewportSize({width, height: width === 390 ? 844 : 1000});
    await load({locale: "zh-CN", data: {...fixture, tasks: [waiting]}});
    await expect(page.getByText("分析 · 等待你的回复", {exact: true})).toBeVisible();
    await page.getByRole("button", {name: "打开任务对话", exact: true}).click();
    assert.deepEqual(await page.evaluate(() => window.__navigation), [{kind: "conversation", id: "original-task-session"}]);
    assert.deepEqual(await page.evaluate(() => window.__actions), []); checks++;
    await noPageOverflow(); await screenshot(`waiting-board-${width}`);
    await open("todo");
    await expect(detail().getByRole("region", {name: "当前执行"}).getByText("分析 · 等待你的回复", {exact: true})).toBeVisible();
    await expect(detail().getByRole("textbox", {name: question})).toHaveCount(0);
    await expect(detail().getByRole("button", {name: "执行", exact: true})).toBeDisabled();
    await expect(detail().getByRole("button", {name: "停止", exact: true})).toBeEnabled();
    await expect(detail().getByRole("button", {name: "结束本次尝试", exact: true})).toHaveCount(0);
    await expect(detail().getByRole("button", {name: "继续", exact: true})).toHaveCount(0);
    await expect(detail().getByRole("button", {name: "重试", exact: true})).toHaveCount(0);
    await detail().getByRole("button", {name: "打开任务对话", exact: true}).click();
    assert.equal((await page.evaluate(() => window.__navigation.at(-1))).id, "original-task-session"); checks++;
    await noPageOverflow(); await screenshot(`waiting-detail-${width}`);
    await page.keyboard.press("Escape");
    await page.getByRole("tab", {name: "列表", exact: true}).click();
    await expect(page.getByRole("table").getByText("分析 · 等待你的回复", {exact: true})).toBeVisible();
    await page.getByRole("table").getByRole("button", {name: "打开任务对话", exact: true}).click();
    assert.equal((await page.evaluate(() => window.__navigation.at(-1))).id, "original-task-session"); checks++;
    await noPageOverflow(); await screenshot(`waiting-list-${width}`);
  }
  await page.setViewportSize({width: 1440, height: 1000});
  // Old conversation metadata must never select a bespoke conversation UI.
  await load({data: {...fixture, tasks: [waiting], selectedTaskId: waiting.id, conversationRunId: waitingRun.id}});
  await expect(page.locator(".kb-page")).toHaveCount(1);
  await expect(page.locator(".kb-task-conversation,.kb-clarification")).toHaveCount(0);
  assert.deepEqual(await page.evaluate(() => window.__navigation), []); checks++;
  await page.evaluate(() => { window.__navigationFailure = "Conversation unavailable"; });
  await detail().getByRole("button", {name: "Open task conversation", exact: true}).click();
  await expect(detail().getByRole("alert")).toContainText("Conversation unavailable"); checks++;
  const awaitingReport = {...waiting, runs: [delivery, {...waitingRun, state: "completed", waitingForInput: false, awaitingReport: true, finishedAt: now + 20000}]};
  for (const width of [390, 1440]) {
    await page.setViewportSize({width, height: width === 390 ? 844 : 1000});
    await load({data: {...fixture, tasks: [awaitingReport]}}); await open("todo");
    const notice = detail().getByRole("region", {name: "Current run"});
    await expect(notice.getByText("Awaiting task report", {exact: true})).toBeVisible();
    await expect(notice.getByText("Analysis · Conversation turn finished", {exact: true})).toBeVisible();
    await expect(detail().getByRole("button", {name: "Start", exact: true})).toBeDisabled();
    await expect(detail().getByRole("button", {name: "Analyze", exact: true})).toBeDisabled();
    await expect(detail().getByRole("button", {name: "Continue", exact: true})).toHaveCount(0);
    await expect(detail().getByRole("button", {name: "Retry", exact: true})).toHaveCount(0);
    await expect(detail().getByRole("button", {name: "Stop", exact: true})).toHaveCount(0);
    await expect(detail().getByRole("button", {name: "End attempt", exact: true})).toBeEnabled();
    await notice.getByRole("button", {name: "Open task conversation", exact: true}).click();
    assert.deepEqual(await page.evaluate(() => window.__navigation), [{kind: "conversation", id: "original-task-session"}]);
    assert.deepEqual(await page.evaluate(() => window.__actions), []); checks++;
    await noPageOverflow(); await screenshot(`awaiting-report-${width}`);
  }
  await load({data: {...fixture, tasks: [{...awaitingReport, automatic: true}]}}); await open("todo");
  await page.evaluate(() => {window.__failure = "Host is still running";});
  await detail().getByRole("button", {name: "End attempt", exact: true}).click();
  await expectAction("stop", {id: "todo", revision: 7});
  await expect(detail().getByRole("alert")).toContainText("Host is still running");
  assert.deepEqual(await page.evaluate(() => ({active: window.__data.tasks[0].activeRunId, automatic: window.__data.tasks[0].automatic})), {active: waitingRun.id, automatic: true}); checks++;
  await page.evaluate(() => {window.__failure = ""; window.__holdStop = true;});
  await detail().getByRole("button", {name: "End attempt", exact: true}).click();
  await expect.poll(() => page.evaluate(() => typeof window.__releaseStop)).toBe("function");
  await expect(detail().getByRole("button", {name: "End attempt", exact: true})).toBeDisabled();
  await expect(detail().getByRole("button", {name: "Analyze", exact: true})).toBeDisabled();
  assert.deepEqual(await page.evaluate(() => ({active: window.__data.tasks[0].activeRunId, automatic: window.__data.tasks[0].automatic})), {active: waitingRun.id, automatic: true}); checks++;
  // Only the host-confirmed snapshot releases the task and disables automation.
  await page.evaluate(() => {
    const task = window.__data.tasks[0], run = task.runs[1];
    delete task.activeRunId; task.automatic = false; task.revision++;
    run.state = "cancelled"; run.awaitingReport = false;
    window.__releaseStop();
  });
  await expect(detail().getByRole("button", {name: "End attempt", exact: true})).toHaveCount(0);
  await expect(detail().getByRole("button", {name: "Reconfirm requirement", exact: true})).toBeEnabled();
  await expect(detail().locator(".kb-properties").first().getByText("No", {exact: true})).toBeVisible();
  assert.equal((await page.evaluate(() => window.__actions)).length, 2); checks++;
  await load({locale: "zh-CN", data: {...fixture, tasks: [awaitingReport]}}); await open("todo");
  await detail().getByRole("button", {name: "结束本次尝试", exact: true}).click();
  await expectAction("stop", {id: "todo", revision: 7});
  // A native answer and a later report update the existing run in place.
  await load({data: {...fixture, tasks: [waiting], selectedTaskId: waiting.id}});
  await page.evaluate(() => { window.__data.tasks[0].runs[1].waitingForInput = false; window.__emit(); });
  await expect(detail().getByRole("region", {name: "Current run"}).getByText("Analysis · Running", {exact: true})).toBeVisible();
  await expect(page.getByText("Waiting for your reply", {exact: false})).toHaveCount(0); checks++;
  await page.evaluate(at => {
    const task = window.__data.tasks[0], run = task.runs[1];
    Object.assign(run, {state: "completed", awaitingReport: false, reportSubmittedAt: at, finishedAt: at, summary: "Business report received"});
    delete task.activeRunId; task.status = "in_review"; task.revision++; window.__emit();
  }, now + 25000);
  await expect(detail().getByRole("region", {name: "Current run"}).getByText("Report submitted", {exact: true})).toBeVisible();
  await expect(detail().getByRole("button", {name: "Accept", exact: true})).toBeEnabled();
  await detail().getByRole("tab", {name: /^Runs/}).click();
  await expect(detail().getByText("Business report received", {exact: true})).toBeVisible();
  await expect(detail().getByText("Report submitted at", {exact: true})).toBeVisible();
  await detail().getByRole("button", {name: "Accept", exact: true}).click();
  await expectAction("accept", {id: "todo", revision: 8});
  const missingConversation = {...waiting, runs: [{...waitingRun, target: undefined}]};
  await load({data: {...fixture, tasks: [missingConversation]}}); await open("todo");
  await expect(detail().getByRole("button", {name: "Open task conversation", exact: true})).toBeDisabled();
  await expect(detail().getByText("Task conversation unavailable", {exact: true})).toBeVisible(); checks++;
  for (const phase of ["execution", "review"]) {
    await load({data: {...fixture, tasks: [{...awaitingReport, status: "in_review", runs: [{...awaitingReport.runs[1], phase}]}]}}); await open("todo");
    await expect(detail().getByRole("button", {name: "Accept", exact: true})).toBeDisabled();
    await expect(detail().getByRole("button", {name: "Review", exact: true})).toBeDisabled();
    await expect(detail().getByRole("button", {name: "Request rework", exact: true})).toBeDisabled();
    await detail().getByRole("button", {name: "Task management", exact: true}).click();
    await expect(page.getByRole("menuitem", {name: "Edit task", exact: true})).toBeDisabled();
    await expect(page.getByRole("menuitem", {name: "Archive task", exact: true})).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(detail().getByRole("button", {name: "Open task conversation", exact: true})).toBeEnabled(); checks++;
  }
  // Archived analysis questions are historical data, not a pending native question.
  await load({data: {...fixture, tasks: [{...waiting, activeRunId: undefined, status: "todo", runs: [delivery]}]}}); await open("todo");
  await expect(detail().getByRole("button", {name: "Start", exact: true})).toBeEnabled();
  await detail().getByRole("button", {name: "Start", exact: true}).click();
  await expectAction("start", {id: "todo", revision: 7});
  await page.keyboard.press("Escape");
  await choose("Task #2 status", "In progress");
  await expectAction("move", {id: "todo", revision: 7, status: "in_progress"});
  // Legacy questions remain actionable through native analysis on the board.
  for (const [width, locale, runs] of [[390, "en", []], [1440, "zh-CN", [{...delivery, phase: "analysis"}]]]) {
    await page.setViewportSize({width, height: width === 390 ? 844 : 1000});
    const legacy = {...waiting, activeRunId: undefined, status: "blocked", blockReason: question, runs};
    await load({locale, data: {...fixture, tasks: [legacy]}}); await open("todo");
    const reconfirm = detail().getByRole("button", {name: locale === "en" ? "Reconfirm requirement" : "重新确认需求", exact: true});
    await expect(reconfirm).toBeEnabled();
    await expect(detail().getByRole("textbox", {name: question})).toHaveCount(0);
    await expect(page.locator(".kb-clarification")).toHaveCount(0);
    await noPageOverflow(); await screenshot(`legacy-questions-${width}`);
    await reconfirm.click(); await expectAction("analyze", {id: "todo", revision: 7});
    await expect(detail().getByRole("button", {name: locale === "en" ? "Start" : "执行", exact: true})).toBeEnabled();
  }
  await load({ failLoad: true }); await expect(page.getByRole("alert")).toContainText("Snapshot unavailable"); checks++;
  await load({ loading: true }); await expect(page.getByRole("status")).toContainText("正在加载");
  await expect(page.getByRole("button", { name: "新建任务", exact: true })).toBeDisabled(); checks++;
  assert.deepEqual(failures, []);
  console.log(`PASS: ${checks} UI assertions; board, list, editor and waiting screenshots at 390/900/1440; native question navigation, awaiting reports, review/accept; Chinese, dark theme, loading/error/empty states.`);
} catch (error) {
  await screenshot("failed-state");
  console.log(await page.evaluate(() => ({ dialogs: [...document.querySelectorAll('[role="dialog"]')].map(node => node.querySelector("h2")?.textContent), focus: document.activeElement?.tagName, last: window.__actions.at(-1) })));
  throw error;
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve));
}
