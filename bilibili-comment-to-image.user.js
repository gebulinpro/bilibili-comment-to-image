// ==UserScript==
// @name         B站评论转图片发布
// @namespace    https://github.com/gebulinpro/bilibili-comment-to-image
// @version      1.4.2
// @description  在 B 站评论区「发布」按钮旁添加「🖼️ 转图发布」，把评论框里的文字渲染成图片后以图片评论发布（穿透 Shadow DOM，纯前端调 B 站官方接口）
// @author       gebulinpro
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/list/*
// @match        https://www.bilibili.com/bangumi/play/*
// @match        https://www.bilibili.com/opus/*
// @match        https://www.bilibili.com/_dynamic/*
// @match        https://t.bilibili.com/*
// @grant        none
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function () {
  "use strict";

  /* ============== 常量 ============== */
  // 标记已注入按钮，避免重复
  const BTN_FLAG = "data-c2i-btn";
  const TOAST_ID = "c2i-toast";
  // B站粉
  const ACCENT = "#fb7299";
  // 视觉空白填充：用盲文空白格(U+2800)替代固定文字，用户看到空白、服务端视为非空字符，
  // 借此绕开 B 站「不可发送空白内容」(12066) 的服务端校验（零宽字符会被服务端剥离，故不可用）
  const EMPTY_FILLER = "\u2800";

  /* ============== Shadow DOM 穿透 ============== */
  // 递归查询所有 shadow root 里匹配 selector 的元素
  function deepAll(selector, root) {
    const out = [];
    (function walk(node) {
      if (!node) return;
      // 进入节点自身的 shadow root（root 为元素时尤其关键）
      if (node.shadowRoot) walk(node.shadowRoot);
      if (node.querySelectorAll) {
        try { out.push(...node.querySelectorAll(selector)); } catch (e) {}
        node.querySelectorAll("*").forEach((el) => {
          if (el.shadowRoot) walk(el.shadowRoot);
        });
      }
    })(root || document);
    return out;
  }

  // 向上穿越 shadow 边界，返回祖先链
  function upChain(el) {
    const chain = [];
    let n = el;
    while (n) {
      chain.push(n);
      const r = n.getRootNode && n.getRootNode();
      if (r && r.host) n = r.host;
      else n = n.parentElement;
    }
    return chain;
  }

  /* ============== 工具：Toast ============== */
  function toast(msg, type) {
    let el = document.getElementById(TOAST_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = TOAST_ID;
      el.style.cssText =
        "position:fixed;left:50%;top:80px;transform:translateX(-50%);" +
        "z-index:2147483647;padding:10px 18px;border-radius:8px;font-size:14px;" +
        "font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;" +
        "box-shadow:0 4px 16px rgba(0,0,0,.18);color:#fff;max-width:80vw;" +
        "line-height:1.5;transition:opacity .3s;pointer-events:none;background:" + ACCENT + ";";
      document.body.appendChild(el);
    }
    el.style.background = type === "error" ? "#f25d8e" : type === "ok" ? "#23c08b" : ACCENT;
    el.textContent = msg;
    el.style.opacity = "1";
    clearTimeout(el._t);
    // 错误提示停留更久，避免被忽略
    el._t = setTimeout(() => { el.style.opacity = "0"; }, type === "error" ? 5000 : 3200);
  }

  /* ============== 工具：Cookie ============== */
  function getCookie(name) {
    const m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : "";
  }

  /* ============== BV -> aid ============== */
  function bvToAid(bv) {
    const table = "FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8id6aOoz9ZHQX1rBvRDoIFYmUykqel0MS";
    const xor = [11, 10, 3, 8, 4, 6];
    const base = bv.replace(/^BV/i, "");
    let tmp = "";
    for (let i = 0; i < 6; i++) tmp += base[xor[i]] || "";
    let x = 0;
    for (let i = tmp.length - 1; i >= 0; i--) x = x * 58 + table.indexOf(tmp[i]);
    return (x ^ 23442827791579) >>> 0;
  }

  /* ============== 获取当前页 oid / type ============== */
  function getOidType() {
    let st = window.__INITIAL_STATE__;
    if (st) {
      if (st.aid) return { oid: st.aid, type: 1, bvid: st.bvid };
      if (st.mediaInfo && st.mediaInfo.id) return { oid: st.mediaInfo.id, type: 1 };
      if (st.epInfo && st.epInfo.aid) return { oid: st.epInfo.aid, type: 1 };
    }
    const m = location.pathname.match(/\/video\/(BV\w+)/i);
    if (m) return { oid: bvToAid(m[1]), type: 1, bvid: m[1] };
    const opus = location.pathname.match(/\/opus\/(\d+)/);
    if (opus) return { oid: opus[1], type: 11 };
    const dyn = location.pathname.match(/\/_dynamic\/(\d+)/);
    if (dyn) return { oid: dyn[1], type: 17 };
    return { oid: 0, type: 1 };
  }

  /* ============== 把文字渲染成 PNG Blob（纯白简洁卡片） ============== */
  function textToImage(text) {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const maxW = 600;               // 正文最大宽度
    const padX = 24, padY = 20;     // 内边距
    const fontSize = 19;
    const lineHeight = Math.round(fontSize * 1.7);

    const fontStr = fontSize + 'px "PingFang SC","Microsoft YaHei","Helvetica Neue",sans-serif';
    const measure = document.createElement("canvas").getContext("2d");
    measure.font = fontStr;

    // 逐字符换行（CJK 友好），超长英文/URL 也会强制断行
    const lines = [];
    for (const para of String(text).split("\n")) {
      let line = "";
      for (const ch of para) {
        const test = line + ch;
        if (measure.measureText(test).width > maxW && line) {
          lines.push(line);
          line = ch;
        } else line = test;
      }
      lines.push(line);
    }
    if (lines.length === 0) lines.push(" ");

    let contentW = 320;
    lines.forEach((l) => { contentW = Math.max(contentW, Math.ceil(measure.measureText(l).width)); });
    contentW = Math.min(contentW, maxW);

    const W = contentW + padX * 2;
    const H = padY * 2 + lines.length * lineHeight;

    const cv = document.createElement("canvas");
    cv.width = W * dpr;
    cv.height = H * dpr;
    const ctx = cv.getContext("2d");
    ctx.scale(dpr, dpr);

    // 纯白圆角卡片 + 细描边（简洁规整，仅评论文字，无品牌/日期/水印）
    const r = 16;
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.arcTo(W, 0, W, H, r);
    ctx.arcTo(W, H, 0, H, r);
    ctx.arcTo(0, H, 0, 0, r);
    ctx.arcTo(0, 0, W, 0, r);
    ctx.closePath();
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = "#e5e7eb";
    ctx.stroke();

    // 正文（仅评论文字）
    ctx.fillStyle = "#1f2329";
    ctx.font = fontStr;
    ctx.textBaseline = "top";
    let y = padY;
    lines.forEach((l) => { ctx.fillText(l, padX, y); y += lineHeight; });

    return new Promise((resolve) => cv.toBlob((b) => resolve(b), "image/png"));
  }

  /* ============== MD5（WBI 签名用，已通过标准向量校验） ============== */
  function md5(string) {
    function md5cycle(x, k) {
      let a = x[0], b = x[1], c = x[2], d = x[3];
      a = ff(a, b, c, d, k[0], 7, -680876936); d = ff(d, a, b, c, k[1], 12, -389564586);
      c = ff(c, d, a, b, k[2], 17, 606105819); b = ff(b, c, d, a, k[3], 22, -1044525330);
      a = ff(a, b, c, d, k[4], 7, -176418897); d = ff(d, a, b, c, k[5], 12, 1200080426);
      c = ff(c, d, a, b, k[6], 17, -1473231341); b = ff(b, c, d, a, k[7], 22, -45705983);
      a = ff(a, b, c, d, k[8], 7, 1770035416); d = ff(d, a, b, c, k[9], 12, -1958414417);
      c = ff(c, d, a, b, k[10], 17, -42063); b = ff(b, c, d, a, k[11], 22, -1990404162);
      a = ff(a, b, c, d, k[12], 7, 1804603682); d = ff(d, a, b, c, k[13], 12, -40341101);
      c = ff(c, d, a, b, k[14], 17, -1502002290); b = ff(b, c, d, a, k[15], 22, 1236535329);
      a = gg(a, b, c, d, k[1], 5, -165796510); d = gg(d, a, b, c, k[6], 9, -1069501632);
      c = gg(c, d, a, b, k[11], 14, 643717713); b = gg(b, c, d, a, k[0], 20, -373897302);
      a = gg(a, b, c, d, k[5], 5, -701558691); d = gg(d, a, b, c, k[10], 9, 38016083);
      c = gg(c, d, a, b, k[15], 14, -660478335); b = gg(b, c, d, a, k[4], 20, -405537848);
      a = gg(a, b, c, d, k[9], 5, 568446438); d = gg(d, a, b, c, k[14], 9, -1019803690);
      c = gg(c, d, a, b, k[3], 14, -187363961); b = gg(b, c, d, a, k[8], 20, 1163531501);
      a = gg(a, b, c, d, k[13], 5, -1444681467); d = gg(d, a, b, c, k[2], 9, -51403784);
      c = gg(c, d, a, b, k[7], 14, 1735328473); b = gg(b, c, d, a, k[12], 20, -1926607734);
      a = hh(a, b, c, d, k[5], 4, -378558); d = hh(d, a, b, c, k[8], 11, -2022574463);
      c = hh(c, d, a, b, k[11], 16, 1839030562); b = hh(b, c, d, a, k[14], 23, -35309556);
      a = hh(a, b, c, d, k[1], 4, -1530992060); d = hh(d, a, b, c, k[4], 11, 1272893353);
      c = hh(c, d, a, b, k[7], 16, -155497632); b = hh(b, c, d, a, k[10], 23, -1094730640);
      a = hh(a, b, c, d, k[13], 4, 681279174); d = hh(d, a, b, c, k[0], 11, -358537222);
      c = hh(c, d, a, b, k[3], 16, -722521979); b = hh(b, c, d, a, k[6], 23, 76029189);
      a = hh(a, b, c, d, k[9], 4, -640364487); d = hh(d, a, b, c, k[12], 11, -421815835);
      c = hh(c, d, a, b, k[15], 16, 530742520); b = hh(b, c, d, a, k[2], 23, -995338651);
      a = ii(a, b, c, d, k[0], 6, -198630844); d = ii(d, a, b, c, k[7], 10, 1126891415);
      c = ii(c, d, a, b, k[14], 15, -1416354905); b = ii(b, c, d, a, k[5], 21, -57434055);
      a = ii(a, b, c, d, k[12], 6, 1700485571); d = ii(d, a, b, c, k[3], 10, -1894986606);
      c = ii(c, d, a, b, k[10], 15, -1051523); b = ii(b, c, d, a, k[1], 21, -2054922799);
      a = ii(a, b, c, d, k[8], 6, 1873313359); d = ii(d, a, b, c, k[15], 10, -30611744);
      c = ii(c, d, a, b, k[6], 15, -1560198380); b = ii(b, c, d, a, k[13], 21, 1309151649);
      a = ii(a, b, c, d, k[4], 6, -145523070); d = ii(d, a, b, c, k[11], 10, -1120210379);
      c = ii(c, d, a, b, k[2], 15, 718787259); b = ii(b, c, d, a, k[9], 21, -343485551);
      x[0] = add32(a, x[0]); x[1] = add32(b, x[1]); x[2] = add32(c, x[2]); x[3] = add32(d, x[3]);
    }
    function cmn(q, a, b, x, s, t) { a = add32(add32(a, q), add32(x, t)); return add32((a << s) | (a >>> (32 - s)), b); }
    function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
    function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
    function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
    function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }
    function md5blk(s) { const m = []; for (let i = 0; i < 64; i += 4) m[i >> 2] = s.charCodeAt(i) + (s.charCodeAt(i + 1) << 8) + (s.charCodeAt(i + 2) << 16) + (s.charCodeAt(i + 3) << 24); return m; }
    function md51(s) {
      const txt = unescape(encodeURIComponent(s)); const n = txt.length;
      const state = [1732584193, -271733879, -1732584194, 271733878];
      let i;
      for (i = 64; i <= n; i += 64) md5cycle(state, md5blk(txt.substring(i - 64, i)));
      const tail = new Array(16).fill(0);
      const rest = txt.substring(i - 64);
      for (i = 0; i < rest.length; i++) tail[i >> 2] |= rest.charCodeAt(i) << ((i % 4) << 3);
      tail[i >> 2] |= 0x80 << ((i % 4) << 3);
      if (i > 55) { md5cycle(state, tail); for (i = 0; i < 16; i++) tail[i] = 0; }
      tail[14] = n * 8;
      md5cycle(state, tail);
      return state;
    }
    function add32(a, b) { return (a + b) & 0xFFFFFFFF; }
    const hex_chr = "0123456789abcdef";
    function rhex(n) { let s = ""; for (let j = 0; j < 4; j++) s += hex_chr.charAt((n >> (j * 8 + 4)) & 0x0F) + hex_chr.charAt((n >> (j * 8)) & 0x0F); return s; }
    function hex(x) { return x.map(rhex).join(""); }
    return hex(md51(string));
  }

  /* ============== WBI 签名（与 B 站前端一致） ============== */
  const MixinKeyEncTab = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];
  let _wbiKeys = null;
  async function getWbiKeys() {
    if (_wbiKeys) return _wbiKeys;
    const r = await fetch("https://api.bilibili.com/x/web-interface/nav", { credentials: "include" });
    const d = await r.json();
    const img = (d.data && d.data.wbi_img) || {};
    const cut = (u) => (u || "").substring(u.lastIndexOf("/") + 1, u.lastIndexOf("."));
    _wbiKeys = { imgKey: cut(img.img_url), subKey: cut(img.sub_url) };
    return _wbiKeys;
  }
  function getMixinKey(orig) { return MixinKeyEncTab.map((i) => orig[i]).join("").slice(0, 32); }
  function encWbi(params, imgKey, subKey) {
    const mixinKey = getMixinKey(imgKey + subKey);
    const wts = Math.round(Date.now() / 1000);
    const chrFilter = /[!'()*]/g;
    const p = Object.assign({}, params, { wts });
    const query = Object.keys(p).sort().map((k) => {
      const v = p[k].toString().replace(chrFilter, "");
      return encodeURIComponent(k) + "=" + encodeURIComponent(v);
    }).join("&");
    return query + "&w_rid=" + md5(query + mixinKey);
  }

  /* ============== 上传图片到 B 站图床（对齐官方 commentpc 组件） ============== */
  async function uploadImage(blob) {
    const csrf = getCookie("bili_jct");
    const fd = new FormData();
    // 与 B 站官方一致：file_up / biz=new_dyn / category=daily
    fd.append("file_up", blob, "comment.png");
    fd.append("biz", "new_dyn");
    fd.append("category", "daily");
    fd.append("csrf", csrf);

    const r = await fetch("https://api.bilibili.com/x/dynamic/feed/draw/upload_bfs", {
      method: "POST",
      credentials: "include",
      body: fd,
    });
    const d = await r.json();
    if (d.code !== 0) throw new Error("图片上传失败: " + (d.message || d.code));
    const img = d.data || {};
    // 官方字段：image_url / image_width / image_height / img_size
    const src = img.image_url || img.img_src;
    if (!src) throw new Error("图片上传返回异常");
    return {
      img_src: src,
      img_width: img.image_width || 0,
      img_height: img.image_height || 0,
      img_size: img.img_size || img.image_size || 0,
    };
  }

  /* ============== 以图片评论发布（URL 编码 + WBI 签名） ============== */
  async function postImageReply(oid, type, pic, message) {
    const csrf = getCookie("bili_jct");
    if (!csrf) throw new Error("未登录或缺少 bili_jct，请先登录 B 站");
    const { imgKey, subKey } = await getWbiKeys();
    if (!imgKey || !subKey) throw new Error("获取 WBI 签名密钥失败");

    // 与官方 reply/add 参数一致，附加 gaia_source=main_web；message 必填（B站不允许空白）
    const params = {
      oid: String(oid),
      type: String(type),
      message: message || "",
      pictures: JSON.stringify([pic]),
      gaia_source: "main_web",
      csrf: csrf,
    };
    const body = encWbi(params, imgKey, subKey);

    const r = await fetch("https://api.bilibili.com/x/v2/reply/add", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body,
    });
    const d = await r.json();
    if (d.code !== 0) throw new Error("发布失败: " + (d.message || d.code));
    return d;
  }

  /* ============== 读取 / 清空 评论框 ============== */
  function readCommentText(box) {
    const ed = deepAll(".brt-editor, [contenteditable='true']", box)[0];
    if (!ed) return "";
    return (ed.innerText || ed.textContent || "").trim();
  }

  function clearCommentBox(box) {
    const ed = deepAll(".brt-editor, [contenteditable='true']", box)[0];
    if (!ed) return;
    ed.innerText = "";
    ed.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
  }

  /* ============== 主流程：转图发布 ============== */
  async function convertAndPublish(btn) {
    if (btn.dataset.c2iBusy) return;
    // 点击时实时定位评论框，避免注入时的引用被 B 站重渲染作废
    const box = upChain(btn).find((n) => n.tagName === "BILI-COMMENT-BOX") || document;
    btn.dataset.c2iBusy = "1";
    const oldText = btn.textContent;
    btn.textContent = "生成中…";
    btn.style.opacity = "0.7";

    try {
      const text = readCommentText(box);
      if (!text) { toast("评论框是空的，先写点字吧", "error"); return; }

      btn.textContent = "上传中…";
      const blob = await textToImage(text);
      const pic = await uploadImage(blob);

      btn.textContent = "发布中…";
      const { oid, type } = getOidType();
      if (!oid) throw new Error("无法识别当前视频/动态 oid，请在视频页使用");
      // 正文用视觉空白字符填充（用户看到空白，服务端视为非空），评论内容只出现在图片里
      await postImageReply(oid, type, pic, EMPTY_FILLER);

      clearCommentBox(box);
      toast("✅ 已发布图片评论，刷新评论区可见", "ok");
    } catch (e) {
      console.error("[B站评论转图]", e);
      toast(e.message || "出错了", "error");
    } finally {
      btn.textContent = oldText;
      btn.style.opacity = "1";
      delete btn.dataset.c2iBusy;
    }
  }

  /* ============== 注入「转图发布」按钮 ============== */
  function injectButton() {
    // 清理残留：已脱离文档，或前面不再是「发布」按钮的转图按钮（B 站重渲染会产生孤儿）
    deepAll("button[" + BTN_FLAG + "]").forEach((b) => {
      const prev = b.previousElementSibling;
      const prevIsPub = prev && /^(发布|发送)$/.test((prev.textContent || "").trim());
      if (!b.isConnected || !prevIsPub) b.remove();
    });

    // 找出所有「发布」按钮（穿透 shadow）
    const pubs = deepAll("button").filter((b) => {
      const t = (b.textContent || "").trim();
      return t === "发布" || t === "发送";
    });

    pubs.forEach((pub) => {
      // 只处理「主评论框」：其祖先链含 bili-comment-box 但不含回复渲染器
      const chain = upChain(pub);
      const box = chain.find((n) => n.tagName === "BILI-COMMENT-BOX");
      const isReply = chain.some((n) =>
        ["BILI-COMMENT-RENDERER", "BILI-COMMENT-REPLY-RENDERER", "BILI-COMMENT-REPLIES-RENDERER"].includes(n.tagName)
      );
      if (!box || isReply) return;
      // 防重：同一父容器已有我们的按钮就跳过（抗 B 站重渲染，不靠易失的 dataset 标记）
      if (pub.parentNode && pub.parentNode.querySelector("[" + BTN_FLAG + "]")) return;

      // 克隆原按钮几何样式，换成粉色
      const cs = getComputedStyle(pub);
      const btn = document.createElement("button");
      btn.setAttribute(BTN_FLAG, "1");
      btn.textContent = "🖼️ 转图发布";
      btn.style.cssText =
        "display:inline-flex;align-items:center;justify-content:center;white-space:nowrap;" +
        "height:" + cs.height + ";padding:0 " + cs.paddingRight + ";" +
        "margin-left:10px;border:none;border-radius:" + cs.borderRadius + ";" +
        "font-size:" + cs.fontSize + ";font-family:" + cs.fontFamily + ";" +
        "background:" + ACCENT + ";color:#fff;cursor:pointer;position:relative;z-index:1;";
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        convertAndPublish(btn);
      });

      if (pub.nextSibling) pub.parentNode.insertBefore(btn, pub.nextSibling);
      else pub.parentNode.appendChild(btn);
    });
  }

  /* ============== 启动 ============== */
  function boot() {
    injectButton();
    // shadow DOM 内部变化不会冒泡到 document 观察器，故用轮询兜底
    const mo = new MutationObserver(() => injectButton());
    mo.observe(document.documentElement, { childList: true, subtree: true });
    setInterval(injectButton, 1500);

    // 事件委托兜底：即使按钮直接监听因 B 站重渲染丢失，也能在 document 捕获阶段接住点击
    document.addEventListener("click", (e) => {
      const path = e.composedPath ? e.composedPath() : [];
      const btn = path.find((n) => n && n.hasAttribute && n.hasAttribute(BTN_FLAG));
      if (btn) {
        e.preventDefault();
        convertAndPublish(btn);
      }
    }, true);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
