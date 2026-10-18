const form = document.querySelector("#postForm");
const input = document.querySelector("#messageInput");
const ttlSelect = document.querySelector("#ttlSelect");
const count = document.querySelector("#charCount");
const feed = document.querySelector("#feed");
const postCount = document.querySelector("#postCount");
const formMessage = document.querySelector("#formMessage");
const submitBtn = document.querySelector("#submitBtn");
const refreshBtn = document.querySelector("#refreshBtn");
const sortBtn = document.querySelector("#sortBtn");
let posts = [];
let newestFirst = true;
let serverOffset = 0;

document.querySelector("#year").textContent = new Date().getFullYear();
input.addEventListener("input", () => count.textContent = `${input.value.length} / 1000`);

function relativeTime(timestamp) {
  const seconds = Math.max(0, Math.floor((Date.now() + serverOffset - timestamp) / 1000));
  if (seconds < 60) return "только что";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} мин. назад`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} ч. назад`;
  return `${Math.floor(seconds / 86400)} дн. назад`;
}
function remainingTime(timestamp) {
  const seconds = Math.max(0, Math.floor((timestamp - (Date.now() + serverOffset)) / 1000));
  if (seconds < 60) return "скоро исчезнет";
  if (seconds < 3600) return `исчезнет через ${Math.ceil(seconds / 60)} мин.`;
  if (seconds < 86400) return `исчезнет через ${Math.ceil(seconds / 3600)} ч.`;
  return `исчезнет через ${Math.ceil(seconds / 86400)} дн.`;
}
function escapeText(value) {
  // Text is inserted only as textContent; this helper is for safe fallback labels.
  return String(value ?? "");
}
function render() {
  const ordered = [...posts].sort((a, b) => newestFirst ? b.createdAt - a.createdAt : a.createdAt - b.createdAt);
  postCount.textContent = String(ordered.length).padStart(2, "0");
  if (!ordered.length) {
    feed.innerHTML = '<div class="empty-state"><div class="empty-symbol">∅</div><p>Здесь пока тихо.<br>Будь первым, кто оставит мысль.</p></div>';
    return;
  }
  feed.replaceChildren();
  for (const post of ordered) {
    const article = document.createElement("article");
    article.className = "post-card";
    const top = document.createElement("div"); top.className = "post-top";
    const anon = document.createElement("div"); anon.className = "anon-label";
    const avatar = document.createElement("span"); avatar.className = "anon-avatar"; avatar.textContent = "◌";
    const label = document.createElement("span"); label.textContent = "АНОНИМНЫЙ ГОЛОС";
    anon.append(avatar, label);
    const time = document.createElement("time"); time.className = "post-time"; time.dateTime = new Date(post.createdAt).toISOString(); time.textContent = relativeTime(post.createdAt);
    top.append(anon, time);
    const message = document.createElement("p"); message.className = "post-text"; message.textContent = escapeText(post.text);
    const bottom = document.createElement("div"); bottom.className = "post-bottom";
    const expires = document.createElement("span"); expires.className = "expires"; expires.textContent = remainingTime(post.expiresAt);
    const report = document.createElement("button"); report.className = "report-button"; report.type = "button"; report.textContent = "⚑ Пожаловаться";
    report.addEventListener("click", () => reportPost(post.id, report));
    bottom.append(expires, report);
    article.append(top, message, bottom);
    feed.append(article);
  }
}
async function loadPosts() {
  try {
    const response = await fetch("/api/posts", { cache: "no-store" });
    if (!response.ok) throw new Error("Не удалось загрузить ленту.");
    const data = await response.json();
    posts = data.posts || [];
    serverOffset = (data.serverTime || Date.now()) - Date.now();
    render();
  } catch (error) {
    feed.innerHTML = "";
    const box = document.createElement("div"); box.className = "empty-state";
    const symbol = document.createElement("div"); symbol.className = "empty-symbol"; symbol.textContent = "⌁";
    const message = document.createElement("p"); message.textContent = "Не удалось подключиться. Проверь, что сервер запущен, и обнови страницу.";
    box.append(symbol, message); feed.append(box);
  }
}
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text) { showMessage("Напиши хотя бы пару слов.", true); input.focus(); return; }
  submitBtn.disabled = true; submitBtn.querySelector("span:first-child").textContent = "Публикуем…";
  showMessage("");
  try {
    const response = await fetch("/api/posts", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, ttlSeconds: Number(ttlSelect.value) })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Не удалось опубликовать сообщение.");
    input.value = ""; count.textContent = "0 / 1000";
    showMessage("Сообщение опубликовано. Пусть живёт своим сроком.");
    await loadPosts();
  } catch (error) { showMessage(error.message || "Ошибка сети. Попробуй ещё раз.", true); }
  finally { submitBtn.disabled = false; submitBtn.querySelector("span:first-child").textContent = "Опубликовать"; }
});
function showMessage(message, error = false) {
  formMessage.textContent = message; formMessage.classList.toggle("error", error);
}
async function reportPost(id, button) {
  if (!confirm("Пожаловаться на это сообщение? Не используй жалобы просто потому, что не согласен с автором.")) return;
  button.disabled = true;
  try {
    const response = await fetch(`/api/posts/${encodeURIComponent(id)}/report`, { method: "POST" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Не удалось отправить жалобу.");
    button.textContent = data.hidden ? "Скрыто по жалобам" : "Жалоба отправлена";
    if (data.hidden) await loadPosts();
  } catch (error) { button.textContent = "Не получилось"; button.disabled = false; }
}
refreshBtn.addEventListener("click", loadPosts);
sortBtn.addEventListener("click", () => {
  newestFirst = !newestFirst;
  sortBtn.innerHTML = newestFirst ? 'СНАЧАЛА НОВЫЕ <span>↕</span>' : 'СНАЧАЛА СТАРЫЕ <span>↕</span>';
  render();
});
loadPosts();
setInterval(loadPosts, 20_000);
setInterval(() => {
  document.querySelectorAll(".post-card").forEach(card => {
    const time = card.querySelector(".post-time");
    // Re-render updates relative timestamps and expiry labels without a full network request.
  });
}, 30_000);
