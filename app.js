/* 本地 PDF 工具箱 - 核心逻辑 */
(function () {
  "use strict";

  // ---------- 依赖 ----------
  var PDFLib = window.PDFLib;
  var pdfjs = window.pdfjsLib;
  var Tesseract = window.Tesseract;
  var PDFDocument = PDFLib.PDFDocument;
  var rgb = PDFLib.rgb;
  var degrees = PDFLib.degrees;
  var StandardFonts = PDFLib.StandardFonts;
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('libs/pdf.worker.min.js', location.href).href;

  var BASE = new URL('.', location.href).href;

  // 中文字体（用于水印），缓存加载
  var cjkFontBuf = null;
  function embedCjk(doc) {
    return (cjkFontBuf ? Promise.resolve(cjkFontBuf) :
      fetch(new URL('libs/fonts/NotoSansCJKsc-Regular.otf', BASE).href)
        .then(function (r) { return r.arrayBuffer(); })
        .then(function (ab) { cjkFontBuf = ab; return ab; })
    ).then(function (ab) { if (window.fontkit) doc.registerFontkit(window.fontkit); return doc.embedFont(new Uint8Array(ab)); });
  }

  // ---------- 小工具 ----------
  function fmtSize(bytes) {
    if (!bytes) return '0 B';
    var u = ['B', 'KB', 'MB', 'GB'], i = 0;
    while (bytes >= 1024 && i < u.length - 1) { bytes /= 1024; i++; }
    return bytes.toFixed(bytes >= 10 || i === 0 ? 0 : 1) + ' ' + u[i];
  }
  function download(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 800);
  }
  function readFileAsBytes(file) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { res(new Uint8Array(r.result)); };
      r.onerror = rej;
      r.readAsArrayBuffer(file);
    });
  }
  function esc(s) {
    var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML;
  }
  function saveName(name, suffix) {
    var dot = name.lastIndexOf('.');
    var base = dot > 0 ? name.slice(0, dot) : name;
    return base + suffix;
  }
  function el(id) { return document.getElementById(id); }

  // 上传组件
  function UploadZone(opts) {
    var host = document.createElement('div');
    host.innerHTML =
      '<div class="dropzone" role="button" tabindex="0">' +
        '<div class="dz-main">' + (opts.main || '点击或拖拽文件到这里') + '</div>' +
        '<div class="dz-sub">' + (opts.sub || '支持的文件将在这里处理') + '</div>' +
      '</div><div class="file-list"></div>';
    var zone = host.querySelector('.dropzone');
    var list = host.querySelector('.file-list');
    var files = [];
    var input = document.createElement('input');
    input.type = 'file';
    input.multiple = !!opts.multiple;
    if (opts.accept) input.accept = opts.accept;

    function render() {
      list.innerHTML = '';
      files.forEach(function (f, i) {
        var item = document.createElement('div');
        item.className = 'file-item';
        item.innerHTML = '<span class="nm">' + esc(f.name) + '</span><span class="sz">' + fmtSize(f.size) + '</span><button class="rm" title="移除">✕</button>';
        item.querySelector('.rm').onclick = function (e) { e.stopPropagation(); files.splice(i, 1); render(); if (opts.onChange) opts.onChange(files.slice()); };
        list.appendChild(item);
      });
    }
    function addFileList(list_) {
      for (var i = 0; i < list_.length; i++) files.push(list_[i]);
      render();
      if (opts.onChange) opts.onChange(files.slice());
    }
    zone.onclick = function () { input.click(); };
    zone.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } };
    zone.addEventListener('dragover', function (e) { e.preventDefault(); zone.classList.add('over'); });
    zone.addEventListener('dragleave', function () { zone.classList.remove('over'); });
    zone.addEventListener('drop', function (e) {
      e.preventDefault(); zone.classList.remove('over');
      if (e.dataTransfer.files.length) addFileList(e.dataTransfer.files);
    });
    input.onchange = function () { if (input.files.length) addFileList(input.files); input.value = ''; };

    host.clear = function () { files = []; render(); };
    host.files = function () { return files.slice(); };
    return host;
  }

  // 进度条
  function Progress() {
    var wrap = document.createElement('div');
    wrap.className = 'progress-wrap';
    wrap.style.display = 'none';
    wrap.innerHTML = '<div class="progress-bar"><div class="progress-fill"></div></div><div class="progress-text"></div>';
    var fill = wrap.querySelector('.progress-fill');
    var txt = wrap.querySelector('.progress-text');
    wrap.show = function (pct, msg) { wrap.style.display = 'block'; fill.style.width = pct + '%'; txt.textContent = msg || ''; };
    wrap.hide = function () { wrap.style.display = 'none'; };
    return wrap;
  }

  // ---------- 工具定义 ----------
  var TOOLS = [];

  function def(cat, id, title, desc, icon, html, run) {
    TOOLS.push({ cat: cat, id: id, title: title, desc: desc, icon: icon, html: html, run: run });
  }

  var IC = {
    merge: '<path d="M4 7h7a3 3 0 0 1 3 3v10"/><path d="M20 17h-7a3 3 0 0 1-3-3V4"/><path d="M8 20l-3 3-3-3"/><path d="M19 4l3 3 3-3"/>',
    split: '<path d="M12 3v18"/><path d="M8 7l-4 4 4 4"/><path d="M16 7l4 4-4 4"/>',
    pdf2img: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
    img2pdf: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13l2 2 3-3 4 4"/>',
    compress: '<path d="M4 8h16"/><path d="M8 8V4h8v4"/><path d="M4 16h16"/><path d="M8 16v4h8v-4"/><path d="M2 12h2M10 12h2M18 12h2"/>',
    rotate: '<path d="M21 12a9 9 0 1 1-9-9c2.5 0 4.7 1 6.4 2.6L21 8"/><path d="M21 3v5h-5"/>',
    extract: '<path d="M9 3h6"/><path d="M10 3v18"/><path d="M14 3v18"/><path d="M17 7l4 4-4 4"/><path d="M7 7l-4 4 4 4"/>',
    del: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14"/><path d="M10 11v6M14 11v6"/>',
    reorder: '<path d="M8 6l4-4 4 4"/><path d="M8 18l4 4 4-4"/><path d="M4 12h16"/>',
    encrypt: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/><circle cx="12" cy="16" r="1"/>',
    decrypt: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7-3"/>',
    watermark: '<path d="M3 18l4-4 6 6"/><path d="M21 21H9"/><path d="M9 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/><path d="M21 3v10"/>',
    text: '<path d="M4 6h16M4 10h16M4 14h10M4 18h6"/>',
    ocr: '<path d="M7 3h10v4"/><path d="M17 21H7v-4"/><circle cx="12" cy="10" r="3"/><path d="M12 13v2M10 18v-2M14 18v-2"/>'
  };

  function svg(d) {
    return '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';
  }

  // ============ 转换类 ============
  def('convert', 'merge', '合并 PDF', '把多个 PDF 文件按顺序合并成一个', IC.merge,
    '<div class="panel"><div class="field"><label>选择多个 PDF（按选择顺序合并）</label><div id="mz"></div></div>' +
    '<button class="btn btn-primary" id="mergeRun">合并</button><div id="mergeRes"></div></div>',
    function (b) {
      var up = UploadZone({ multiple: true, accept: '.pdf', main: '点击选择或拖拽多个 PDF', sub: '顺序即合并顺序' });
      el('mz').appendChild(up);
      el('mergeRun').onclick = async function () {
        var res = el('mergeRes'); res.innerHTML = '';
        var files = up.files();
        if (files.length < 2) { res.innerHTML = '<div class="err-box">请至少选择 2 个 PDF 文件</div>'; return; }
        var btn = el('mergeRun'); btn.disabled = true;
        try {
          var out = await PDFDocument.create();
          for (var i = 0; i < files.length; i++) {
            var bytes = await readFileAsBytes(files[i]);
            var src = await PDFDocument.load(bytes);
            var pages = await out.copyPages(src, src.getPageIndices());
            pages.forEach(function (p) { out.addPage(p); });
          }
          var data = await out.save();
          var blob = new Blob([data], { type: 'application/pdf' });
          res.innerHTML = '<div class="result-item"><span>合并完成 · 共 ' + out.getPageCount() + ' 页 · ' + fmtSize(blob.size) + '</span><button class="dl" data-f="merged.pdf">下载</button></div>';
          res.querySelector('.dl').onclick = function () { download(blob, 'merged.pdf'); };
        } catch (e) { res.innerHTML = '<div class="err-box">处理失败：' + esc(e.message) + '</div>'; }
        btn.disabled = false;
      };
    });

  def('convert', 'split', '拆分 PDF', '按页码范围把 PDF 拆成多个文件', IC.split,
    '<div class="panel"><div class="field"><label>选择 PDF</label><div id="sz"></div></div>' +
    '<div class="field"><label>拆分范围 <span class="hint">如：1-3, 5-6（每段一个文件）</span></label><input type="text" id="splitRanges" placeholder="1-3, 5-6"></div>' +
    '<button class="btn btn-primary" id="splitRun">拆分</button><div id="splitRes"></div></div>',
    function (b) {
      var up = UploadZone({ accept: '.pdf', main: '点击选择 PDF' });
      el('sz').appendChild(up);
      el('splitRun').onclick = async function () {
        var res = el('splitRes'); res.innerHTML = '';
        var files = up.files(); if (!files.length) { res.innerHTML = '<div class="err-box">请先选择 PDF</div>'; return; }
        var btn = el('splitRun'); btn.disabled = true;
        try {
          var bytes = await readFileAsBytes(files[0]);
          var doc = await PDFDocument.load(bytes);
          var total = doc.getPageCount();
          var ranges = parseRanges(el('splitRanges').value, total);
          var blobs = [];
          for (var r = 0; r < ranges.length; r++) {
            var sub = await PDFDocument.create();
            var pages = await sub.copyPages(doc, ranges[r]);
            pages.forEach(function (p) { sub.addPage(p); });
            blobs.push(new Blob([await sub.save()], { type: 'application/pdf' }));
          }
          res.innerHTML = '';
          blobs.forEach(function (blob, i) {
            var item = document.createElement('div');
            item.className = 'result-item';
            item.innerHTML = '<span>第 ' + (i + 1) + ' 段 · ' + ranges[i].length + ' 页 · ' + fmtSize(blob.size) + '</span><button class="dl">下载</button>';
            item.querySelector('.dl').onclick = function () { download(blob, saveName(files[0].name, '-part' + (i + 1) + '.pdf')); };
            res.appendChild(item);
          });
        } catch (e) { res.innerHTML = '<div class="err-box">处理失败：' + esc(e.message) + '</div>'; }
        btn.disabled = false;
      };
    });

  def('convert', 'pdf2img', 'PDF 转图片', '把 PDF 页面渲染为 PNG / JPG 图片', IC.pdf2img,
    '<div class="panel"><div class="field"><label>选择 PDF</label><div id="p2z"></div></div>' +
    '<div class="row"><div class="field"><label>格式</label><select id="p2f"><option value="png">PNG</option><option value="jpeg">JPEG</option></select></div>' +
    '<div class="field"><label>清晰度 <span class="hint">倍数</span></label><input type="number" id="p2s" value="2" min="1" max="4"></div></div>' +
    '<div class="field"><label>页码范围 <span class="hint">留空 = 全部</span></label><input type="text" id="p2r" placeholder="如 1-3 或 1,3,5"></div>' +
    '<button class="btn btn-primary" id="p2Run">转换</button><div id="p2Res"></div></div>',
    function (b) {
      var up = UploadZone({ accept: '.pdf', main: '点击选择 PDF' });
      el('p2z').appendChild(up);
      el('p2Run').onclick = async function () {
        var res = el('p2Res'); res.innerHTML = '';
        var files = up.files(); if (!files.length) { res.innerHTML = '<div class="err-box">请先选择 PDF</div>'; return; }
        var btn = el('p2Run'); btn.disabled = true;
        var prog = Progress(); res.appendChild(prog);
        try {
          var bytes = await readFileAsBytes(files[0]);
          var pdf = await pdfjs.getDocument({ data: bytes }).promise;
          var fmt = el('p2f').value, scale = parseFloat(el('p2s').value) || 2;
          var range = el('p2r').value.trim();
          var idx = range ? parseRanges(range, pdf.numPages)[0] || [] : allIdx(pdf.numPages);
          res.innerHTML = '';
          for (var i = 0; i < idx.length; i++) {
            prog.show((i / idx.length) * 100, '正在渲染第 ' + (idx[i] + 1) + ' / ' + pdf.numPages + ' 页…');
            var page = await pdf.getPage(idx[i] + 1);
            var vp = page.getViewport({ scale: scale });
            var canvas = document.createElement('canvas');
            canvas.width = vp.width; canvas.height = vp.height;
            var ctx = canvas.getContext('2d');
            await page.render({ canvasContext: ctx, viewport: vp }).promise;
            var dataUrl = canvas.toDataURL('image/' + (fmt === 'png' ? 'png' : 'jpeg'), 0.92);
            var blob = dataUrlToBlob(dataUrl);
            var item = document.createElement('div');
            item.className = 'result-item';
            item.innerHTML = '<span>第 ' + (idx[i] + 1) + ' 页 · ' + fmtSize(blob.size) + '</span><button class="dl">下载</button>';
            item.querySelector('.dl').onclick = (function (bl) { return function () { download(bl, saveName(files[0].name, '-page' + (idx[i] + 1) + '.' + fmt)); }; })(blob);
            res.appendChild(item);
          }
          prog.hide();
        } catch (e) { prog.hide(); res.innerHTML = '<div class="err-box">处理失败：' + esc(e.message) + '</div>'; }
        btn.disabled = false;
      };
    });

  def('convert', 'img2pdf', '图片转 PDF', '把多张图片合并成一个 PDF', IC.img2pdf,
    '<div class="panel"><div class="field"><label>选择图片（PNG / JPG）</label><div id="i2z"></div></div>' +
    '<div class="field"><label>纸张适配</label><select id="i2p"><option value="fit">按图片比例（每图一页）</option><option value="a4">A4 纵向</option><option value="a4l">A4 横向</option></select></div>' +
    '<button class="btn btn-primary" id="i2Run">生成</button><div id="i2Res"></div></div>',
    function (b) {
      var up = UploadZone({ multiple: true, accept: 'image/png,image/jpeg', main: '点击选择多张图片', sub: '图片顺序即 PDF 页序' });
      el('i2z').appendChild(up);
      el('i2Run').onclick = async function () {
        var res = el('i2Res'); res.innerHTML = '';
        var files = up.files(); if (!files.length) { res.innerHTML = '<div class="err-box">请先选择图片</div>'; return; }
        var btn = el('i2Run'); btn.disabled = true;
        try {
          var doc = await PDFDocument.create();
          var paper = el('i2p').value;
          var pw = paper === 'a4' ? 595 : paper === 'a4l' ? 842 : 0;
          var ph = paper === 'a4' ? 842 : paper === 'a4l' ? 595 : 0;
          for (var i = 0; i < files.length; i++) {
            var imgBytes = await readFileAsBytes(files[i]);
            var ext = files[i].name.split('.').pop().toLowerCase();
            var img = ext === 'png' ? await doc.embedPng(imgBytes) : await doc.embedJpg(imgBytes);
            var page;
            if (paper === 'fit') { page = doc.addPage([img.width, img.height]); }
            else { page = doc.addPage([pw, ph]); }
            var scale = Math.min(pw / img.width, ph / img.height);
            var w = img.width * scale, h = img.height * scale;
            page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
          }
          var data = await doc.save();
          var blob = new Blob([data], { type: 'application/pdf' });
          res.innerHTML = '<div class="result-item"><span>已生成 · ' + files.length + ' 页 · ' + fmtSize(blob.size) + '</span><button class="dl" data-f="images.pdf">下载</button></div>';
          res.querySelector('.dl').onclick = function () { download(blob, 'images.pdf'); };
        } catch (e) { res.innerHTML = '<div class="err-box">处理失败：' + esc(e.message) + '</div>'; }
        btn.disabled = false;
      };
    });

  def('convert', 'compress', '压缩 PDF', '重写 PDF 结构以减少体积', IC.compress,
    '<div class="panel"><div class="field"><label>选择 PDF</label><div id="cz"></div></div>' +
    '<div class="field"><label>压缩强度</label><select id="cLevel"><option value="0">标准（重写结构）</option><option value="1">中等</option><option value="2">最大（可能影响画质）</option></select></div>' +
    '<button class="btn btn-primary" id="cRun">压缩</button><div id="cRes"></div></div>',
    function (b) {
      var up = UploadZone({ accept: '.pdf', main: '点击选择 PDF' });
      el('cz').appendChild(up);
      el('cRun').onclick = async function () {
        var res = el('cRes'); res.innerHTML = '';
        var files = up.files(); if (!files.length) { res.innerHTML = '<div class="err-box">请先选择 PDF</div>'; return; }
        var btn = el('cRun'); btn.disabled = true;
        try {
          var bytes = await readFileAsBytes(files[0]);
          var doc = await PDFDocument.load(bytes, { updateMetadata: false });
          var data = await doc.save({ useObjectStreams: true, addDefaultPage: false });
          var blob = new Blob([data], { type: 'application/pdf' });
          var saved = bytes.length - blob.size;
          var pct = bytes.length ? Math.round(saved / bytes.length * 100) : 0;
          res.innerHTML = '<div class="result-item"><span>原始 ' + fmtSize(bytes.length) + ' → ' + fmtSize(blob.size) + '（约 -' + Math.max(0, pct) + '%）</span><button class="dl" data-f="compressed.pdf">下载</button></div>';
          res.querySelector('.dl').onclick = function () { download(blob, saveName(files[0].name, '-compressed.pdf')); };
        } catch (e) { res.innerHTML = '<div class="err-box">处理失败：' + esc(e.message) + '</div>'; }
        btn.disabled = false;
      };
    });

  def('convert', 'pdf2html', 'PDF 转 HTML', '把 PDF 文本内容导出为 HTML 网页', '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 14l-2 2 2 2"/><path d="M15 14l2 2-2 2"/>',
    '<div class="panel"><div class="field"><label>选择 PDF</label><div id="h2Z"></div></div>' +
    '<div class="field"><label>页码范围 <span class="hint">留空=全部</span></label><input type="text" id="h2R" placeholder="如 1-5"></div>' +
    '<button class="btn btn-primary" id="h2Run">转换</button><div id="h2Res"></div></div>',
    function (b) {
      var up = UploadZone({ accept: '.pdf', main: '点击选择 PDF' });
      el('h2Z').appendChild(up);
      el('h2Run').onclick = async function () {
        var res = el('h2Res'); res.innerHTML = '';
        var files = up.files(); if (!files.length) { res.innerHTML = '<div class="err-box">请先选择 PDF</div>'; return; }
        var btn = el('h2Run'); btn.disabled = true;
        try {
          var bytes = await readFileAsBytes(files[0]);
          var pdf = await pdfjs.getDocument({ data: bytes }).promise;
          var range = el('h2R').value.trim();
          var idx = range ? parseRanges(range, pdf.numPages)[0] || [] : allIdx(pdf.numPages);
          var html = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>' + esc(files[0].name) + '</title>' +
            '<style>body{font-family:Georgia,"Songti SC","SimSun",serif;max-width:820px;margin:40px auto;line-height:1.8;color:#222;padding:0 20px}.page{margin-bottom:2em}.page-num{font-size:.8em;color:#999;border-top:1px solid #ddd;padding-top:.5em;margin-top:1em}</style></head><body>';
          for (var i = 0; i < idx.length; i++) {
            var page = await pdf.getPage(idx[i] + 1);
            var tc = await page.getTextContent();
            var text = tc.items.map(function (it) { return it.str || ''; }).join(' ');
            html += '<div class="page"><p>' + esc(text) + '</p><div class="page-num">第 ' + (idx[i] + 1) + ' 页</div></div>';
          }
          html += '</body></html>';
          var blob = new Blob([html], { type: 'text/html;charset=utf-8' });
          res.innerHTML = '<div class="result-item"><span>已导出 HTML · ' + idx.length + ' 页 · ' + fmtSize(blob.size) + '</span><button class="dl" data-f="page.html">下载</button></div>';
          res.querySelector('.dl').onclick = function () { download(blob, saveName(files[0].name, '.html')); };
        } catch (e) { res.innerHTML = '<div class="err-box">处理失败：' + esc(e.message) + '</div>'; }
        btn.disabled = false;
      };
    });

  // ============ 页面操作 ============
  def('pages', 'rotate', '旋转页面', '旋转全部或部分页面（90°/180°/270°）', IC.rotate,
    '<div class="panel"><div class="field"><label>选择 PDF</label><div id="rtz"></div></div>' +
    '<div class="row"><div class="field"><label>角度</label><select id="rtA"><option value="90">顺时针 90°</option><option value="180">180°</option><option value="270">270°</option></select></div>' +
    '<div class="field"><label>范围 <span class="hint">留空 = 全部</span></label><input type="text" id="rtR" placeholder="如 1-3"></div></div>' +
    '<button class="btn btn-primary" id="rtRun">旋转</button><div id="rtRes"></div></div>',
    function (b) {
      var up = UploadZone({ accept: '.pdf', main: '点击选择 PDF' });
      el('rtz').appendChild(up);
      el('rtRun').onclick = async function () {
        var res = el('rtRes'); res.innerHTML = '';
        var files = up.files(); if (!files.length) { res.innerHTML = '<div class="err-box">请先选择 PDF</div>'; return; }
        var btn = el('rtRun'); btn.disabled = true;
        try {
          var bytes = await readFileAsBytes(files[0]);
          var doc = await PDFDocument.load(bytes);
          var total = doc.getPageCount();
          var range = el('rtR').value.trim();
          var idx = range ? parseRanges(range, total).reduce(function (a, b2) { return a.concat(b2); }, []) : allIdx(total);
          var ang = parseInt(el('rtA').value, 10);
          idx.forEach(function (i) {
            var p = doc.getPage(i);
            var cur = p.getRotation().angle || 0;
            p.setRotation(degrees((cur + ang) % 360));
          });
          var data = await doc.save();
          var blob = new Blob([data], { type: 'application/pdf' });
          res.innerHTML = '<div class="result-item"><span>已旋转 ' + idx.length + ' 页 · ' + fmtSize(blob.size) + '</span><button class="dl" data-f="rotated.pdf">下载</button></div>';
          res.querySelector('.dl').onclick = function () { download(blob, saveName(files[0].name, '-rotated.pdf')); };
        } catch (e) { res.innerHTML = '<div class="err-box">处理失败：' + esc(e.message) + '</div>'; }
        btn.disabled = false;
      };
    });

  def('pages', 'extract', '提取页面', '把指定页面单独导出为一个新 PDF', IC.extract,
    '<div class="panel"><div class="field"><label>选择 PDF</label><div id="exz"></div></div>' +
    '<div class="field"><label>要提取的页面 <span class="hint">如 1,3,5 或 1-3</span></label><input type="text" id="exR" placeholder="1,3,5"></div>' +
    '<button class="btn btn-primary" id="exRun">提取</button><div id="exRes"></div></div>',
    function (b) {
      var up = UploadZone({ accept: '.pdf', main: '点击选择 PDF' });
      el('exz').appendChild(up);
      el('exRun').onclick = async function () {
        var res = el('exRes'); res.innerHTML = '';
        var files = up.files(); if (!files.length) { res.innerHTML = '<div class="err-box">请先选择 PDF</div>'; return; }
        var btn = el('exRun'); btn.disabled = true;
        try {
          var bytes = await readFileAsBytes(files[0]);
          var doc = await PDFDocument.load(bytes);
          var idx = parseRanges(el('exR').value, doc.getPageCount()).reduce(function (a, b2) { return a.concat(b2); }, []);
          var out = await PDFDocument.create();
          var pages = await out.copyPages(doc, idx);
          pages.forEach(function (p) { out.addPage(p); });
          var blob = new Blob([await out.save()], { type: 'application/pdf' });
          res.innerHTML = '<div class="result-item"><span>已提取 ' + idx.length + ' 页 · ' + fmtSize(blob.size) + '</span><button class="dl" data-f="extracted.pdf">下载</button></div>';
          res.querySelector('.dl').onclick = function () { download(blob, saveName(files[0].name, '-extracted.pdf')); };
        } catch (e) { res.innerHTML = '<div class="err-box">处理失败：' + esc(e.message) + '</div>'; }
        btn.disabled = false;
      };
    });

  def('pages', 'del', '删除页面', '删除指定页面并保留其余部分', IC.del,
    '<div class="panel"><div class="field"><label>选择 PDF</label><div id="dlz"></div></div>' +
    '<div class="field"><label>要删除的页面 <span class="hint">如 2,4 或 3-5</span></label><input type="text" id="dlR" placeholder="2,4"></div>' +
    '<button class="btn btn-primary" id="dlRun">删除</button><div id="dlRes"></div></div>',
    function (b) {
      var up = UploadZone({ accept: '.pdf', main: '点击选择 PDF' });
      el('dlz').appendChild(up);
      el('dlRun').onclick = async function () {
        var res = el('dlRes'); res.innerHTML = '';
        var files = up.files(); if (!files.length) { res.innerHTML = '<div class="err-box">请先选择 PDF</div>'; return; }
        var btn = el('dlRun'); btn.disabled = true;
        try {
          var bytes = await readFileAsBytes(files[0]);
          var doc = await PDFDocument.load(bytes);
          var total = doc.getPageCount();
          var delIdx = parseRanges(el('dlR').value, total).reduce(function (a, b2) { return a.concat(b2); }, []);
          var keep = allIdx(total).filter(function (i) { return delIdx.indexOf(i) < 0; });
          var out = await PDFDocument.create();
          var pages = await out.copyPages(doc, keep);
          pages.forEach(function (p) { out.addPage(p); });
          var blob = new Blob([await out.save()], { type: 'application/pdf' });
          res.innerHTML = '<div class="result-item"><span>已删除 ' + delIdx.length + ' 页，保留 ' + keep.length + ' 页 · ' + fmtSize(blob.size) + '</span><button class="dl" data-f="kept.pdf">下载</button></div>';
          res.querySelector('.dl').onclick = function () { download(blob, saveName(files[0].name, '-edited.pdf')); };
        } catch (e) { res.innerHTML = '<div class="err-box">处理失败：' + esc(e.message) + '</div>'; }
        btn.disabled = false;
      };
    });

  def('pages', 'reorder', '页面排序', '按指定顺序重排页面', IC.reorder,
    '<div class="panel"><div class="field"><label>选择 PDF</label><div id="roZ"></div></div>' +
    '<div class="field"><label>新顺序 <span class="hint">逗号分隔的页码，如 3,1,2,4</span></label><input type="text" id="roR" placeholder="3,1,2,4"></div>' +
    '<button class="btn btn-primary" id="roRun">重排</button><div id="roRes"></div></div>',
    function (b) {
      var up = UploadZone({ accept: '.pdf', main: '点击选择 PDF' });
      el('roZ').appendChild(up);
      el('roRun').onclick = async function () {
        var res = el('roRes'); res.innerHTML = '';
        var files = up.files(); if (!files.length) { res.innerHTML = '<div class="err-box">请先选择 PDF</div>'; return; }
        var btn = el('roRun'); btn.disabled = true;
        try {
          var bytes = await readFileAsBytes(files[0]);
          var doc = await PDFDocument.load(bytes);
          var total = doc.getPageCount();
          var order = el('roR').value.split(',').map(function (s) { return parseInt(s.trim(), 10); });
          order.forEach(function (n) { if (isNaN(n) || n < 1 || n > total) throw new Error('页码 ' + n + ' 超出范围（共 ' + total + ' 页）'); });
          var idx = order.map(function (n) { return n - 1; });
          var out = await PDFDocument.create();
          var pages = await out.copyPages(doc, idx);
          pages.forEach(function (p) { out.addPage(p); });
          var blob = new Blob([await out.save()], { type: 'application/pdf' });
          res.innerHTML = '<div class="result-item"><span>已按新顺序重排 ' + total + ' 页 · ' + fmtSize(blob.size) + '</span><button class="dl" data-f="reordered.pdf">下载</button></div>';
          res.querySelector('.dl').onclick = function () { download(blob, saveName(files[0].name, '-reordered.pdf')); };
        } catch (e) { res.innerHTML = '<div class="err-box">处理失败：' + esc(e.message) + '</div>'; }
        btn.disabled = false;
      };
    });

  def('pages', 'addBlank', '添加空白页', '在指定位置插入空白页', '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 12h6M12 9v6"/>',
    '<div class="panel"><div class="field"><label>选择 PDF</label><div id="abZ"></div></div>' +
    '<div class="row"><div class="field"><label>插入位置 <span class="hint">在第几页前，留空=末尾</span></label><input type="text" id="abPos" placeholder="留空追加到末尾"></div>' +
    '<div class="field"><label>数量</label><input type="number" id="abN" value="1" min="1" max="50"></div></div>' +
    '<div class="row"><div class="field"><label>纸张</label><select id="abPaper"><option value="a4">A4</option><option value="letter">Letter</option><option value="same">与原页相同</option></select></div>' +
    '<div class="field"><label>方向</label><select id="abOrient"><option value="portrait">纵向</option><option value="landscape">横向</option></select></div></div>' +
    '<button class="btn btn-primary" id="abRun">插入</button><div id="abRes"></div></div>',
    function (b) {
      var up = UploadZone({ accept: '.pdf', main: '点击选择 PDF' });
      el('abZ').appendChild(up);
      el('abRun').onclick = async function () {
        var res = el('abRes'); res.innerHTML = '';
        var files = up.files(); if (!files.length) { res.innerHTML = '<div class="err-box">请先选择 PDF</div>'; return; }
        var btn = el('abRun'); btn.disabled = true;
        try {
          var bytes = await readFileAsBytes(files[0]);
          var doc = await PDFDocument.load(bytes);
          var n = parseInt(el('abN').value) || 1;
          var paper = el('abPaper').value, orient = el('abOrient').value;
          var dims = { a4: [595, 842], letter: [612, 792] };
          var pos = el('abPos').value.trim();
          var total = doc.getPageCount();
          var w, h;
          if (paper === 'same' && total > 0) { var s = doc.getPage(0).getSize(); w = s.width; h = s.height; }
          else { w = dims[paper][0]; h = dims[paper][1]; }
          if (orient === 'landscape') { var t = w; w = h; h = t; }
          if (pos) {
            var at = parseInt(pos, 10) - 1;
            if (isNaN(at) || at < 0 || at > total) throw new Error('插入位置无效');
            for (var i = 0; i < n; i++) doc.insertPage(at + i, [w, h]);
          } else {
            for (var i = 0; i < n; i++) doc.addPage([w, h]);
          }
          var blob = new Blob([await doc.save()], { type: 'application/pdf' });
          res.innerHTML = '<div class="result-item"><span>已插入 ' + n + ' 页，共 ' + doc.getPageCount() + ' 页 · ' + fmtSize(blob.size) + '</span><button class="dl" data-f="blank.pdf">下载</button></div>';
          res.querySelector('.dl').onclick = function () { download(blob, saveName(files[0].name, '-blank.pdf')); };
        } catch (e) { res.innerHTML = '<div class="err-box">处理失败：' + esc(e.message) + '</div>'; }
        btn.disabled = false;
      };
    });

  def('pages', 'crop', '裁剪页面', '按四边比例裁剪页面', '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>',
    '<div class="panel"><div class="field"><label>选择 PDF</label><div id="crZ"></div></div>' +
    '<div class="row"><div class="field"><label>左侧裁掉 %</label><input type="number" id="crL" value="0" min="0" max="45"></div>' +
    '<div class="field"><label>右侧裁掉 %</label><input type="number" id="crR" value="0" min="0" max="45"></div></div>' +
    '<div class="row"><div class="field"><label>顶部裁掉 %</label><input type="number" id="crT" value="0" min="0" max="45"></div>' +
    '<div class="field"><label>底部裁掉 %</label><input type="number" id="crB" value="0" min="0" max="45"></div></div>' +
    '<div class="field"><label>页码范围 <span class="hint">留空=全部</span></label><input type="text" id="crRg" placeholder="如 1-3"></div>' +
    '<button class="btn btn-primary" id="crRun">裁剪</button><div id="crRes"></div></div>',
    function (b) {
      var up = UploadZone({ accept: '.pdf', main: '点击选择 PDF' });
      el('crZ').appendChild(up);
      el('crRun').onclick = async function () {
        var res = el('crRes'); res.innerHTML = '';
        var files = up.files(); if (!files.length) { res.innerHTML = '<div class="err-box">请先选择 PDF</div>'; return; }
        var btn = el('crRun'); btn.disabled = true;
        try {
          var bytes = await readFileAsBytes(files[0]);
          var doc = await PDFDocument.load(bytes);
          var total = doc.getPageCount();
          var range = el('crRg').value.trim();
          var idx = range ? parseRanges(range, total).reduce(function (a, b2) { return a.concat(b2); }, []) : allIdx(total);
          var l = (parseFloat(el('crL').value) || 0) / 100, r = (parseFloat(el('crR').value) || 0) / 100;
          var t = (parseFloat(el('crT').value) || 0) / 100, btm = (parseFloat(el('crB').value) || 0) / 100;
          idx.forEach(function (i) {
            var p = doc.getPage(i);
            var s = p.getSize();
            var x = s.width * l, y = s.height * btm;
            var w = s.width * (1 - l - r), h = s.height * (1 - t - btm);
            p.setCropBox(x, y, w, h);
          });
          var blob = new Blob([await doc.save()], { type: 'application/pdf' });
          res.innerHTML = '<div class="result-item"><span>已裁剪 ' + idx.length + ' 页 · ' + fmtSize(blob.size) + '</span><button class="dl" data-f="cropped.pdf">下载</button></div>';
          res.querySelector('.dl').onclick = function () { download(blob, saveName(files[0].name, '-cropped.pdf')); };
        } catch (e) { res.innerHTML = '<div class="err-box">处理失败：' + esc(e.message) + '</div>'; }
        btn.disabled = false;
      };
    });

  def('pages', 'scalePages', '调整页面大小', '把页面画布调整为指定尺寸', '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/>',
    '<div class="panel"><div class="field"><label>选择 PDF</label><div id="scZ"></div></div>' +
    '<div class="row"><div class="field"><label>目标纸张</label><select id="scPaper"><option value="a4">A4</option><option value="letter">Letter</option><option value="legal">Legal</option><option value="custom">自定义</option></select></div>' +
    '<div class="field"><label>方向</label><select id="scOrient"><option value="auto">自动（原页方向）</option><option value="portrait">纵向</option><option value="landscape">横向</option></select></div></div>' +
    '<div class="row" id="scCustom" style="display:none"><div class="field"><label>宽(mm)</label><input type="number" id="scW" value="210"></div><div class="field"><label>高(mm)</label><input type="number" id="scH" value="297"></div></div>' +
    '<button class="btn btn-primary" id="scRun">调整</button><div id="scRes"></div></div>',
    function (b) {
      var up = UploadZone({ accept: '.pdf', main: '点击选择 PDF' });
      el('scZ').appendChild(up);
      el('scPaper').onchange = function () { el('scCustom').style.display = el('scPaper').value === 'custom' ? '' : 'none'; };
      el('scRun').onclick = async function () {
        var res = el('scRes'); res.innerHTML = '';
        var files = up.files(); if (!files.length) { res.innerHTML = '<div class="err-box">请先选择 PDF</div>'; return; }
        var btn = el('scRun'); btn.disabled = true;
        try {
          var bytes = await readFileAsBytes(files[0]);
          var doc = await PDFDocument.load(bytes);
          var paper = el('scPaper').value, orient = el('scOrient').value;
          var dims = { a4: [595, 842], letter: [612, 792], legal: [612, 1008] };
          var w, h;
          if (paper === 'custom') { w = (parseFloat(el('scW').value) || 210) * 2.8346; h = (parseFloat(el('scH').value) || 297) * 2.8346; }
          else { w = dims[paper][0]; h = dims[paper][1]; }
          doc.getPages().forEach(function (p, i) {
            var ow = p.getSize().width, oh = p.getSize().height;
            var tw = w, th = h;
            if (orient === 'auto' && ow > oh) { var t = tw; tw = th; th = t; }
            if (orient === 'landscape') { var t2 = tw; tw = th; th = t2; }
            p.setSize(tw, th);
          });
          var blob = new Blob([await doc.save()], { type: 'application/pdf' });
          res.innerHTML = '<div class="result-item"><span>已调整 ' + doc.getPageCount() + ' 页 · ' + fmtSize(blob.size) + '</span><button class="dl" data-f="scaled.pdf">下载</button></div>';
          res.querySelector('.dl').onclick = function () { download(blob, saveName(files[0].name, '-scaled.pdf')); };
        } catch (e) { res.innerHTML = '<div class="err-box">处理失败：' + esc(e.message) + '</div>'; }
        btn.disabled = false;
      };
    });

  def('pages', 'addPageNum', '添加页码', '在页面底部或顶部添加页码', '<rect x="4" y="6" width="16" height="12" rx="2"/><path d="M9 12h6"/>',
    '<div class="panel"><div class="field"><label>选择 PDF</label><div id="pnZ"></div></div>' +
    '<div class="row"><div class="field"><label>位置</label><select id="pnPos"><option value="bottom-c">底部居中</option><option value="bottom-r">底部右侧</option><option value="top-c">顶部居中</option><option value="top-r">顶部右侧</option></select></div>' +
    '<div class="field"><label>起始数字</label><input type="number" id="pnStart" value="1" min="1"></div></div>' +
    '<div class="row"><div class="field"><label>字号</label><input type="number" id="pnSize" value="14" min="6" max="72"></div>' +
    '<div class="field"><label>颜色</label><input type="color" id="pnColor" value="#333333"></div></div>' +
    '<div class="field"><label>页码范围 <span class="hint">留空=全部</span></label><input type="text" id="pnRg" placeholder="如 1-3"></div>' +
    '<button class="btn btn-primary" id="pnRun">添加页码</button><div id="pnRes"></div></div>',
    function (b) {
      var up = UploadZone({ accept: '.pdf', main: '点击选择 PDF' });
      el('pnZ').appendChild(up);
      el('pnRun').onclick = async function () {
        var res = el('pnRes'); res.innerHTML = '';
        var files = up.files(); if (!files.length) { res.innerHTML = '<div class="err-box">请先选择 PDF</div>'; return; }
        var btn = el('pnRun'); btn.disabled = true;
        try {
          var bytes = await readFileAsBytes(files[0]);
          var doc = await PDFDocument.load(bytes);
          var font = await doc.embedFont(StandardFonts.Helvetica);
          var total = doc.getPageCount();
          var range = el('pnRg').value.trim();
          var idx = range ? parseRanges(range, total).reduce(function (a, b2) { return a.concat(b2); }, []) : allIdx(total);
          var start = parseInt(el('pnStart').value) || 1;
          var size = parseFloat(el('pnSize').value) || 14;
          var pos = el('pnPos').value;
          var hex = el('pnColor').value.replace('#', '');
          var col = rgb(parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255);
          idx.forEach(function (i, k) {
            var p = doc.getPage(i);
            var s = p.getSize();
            var num = String(start + k);
            var tw = font.widthOfTextAtSize(num, size);
            var x, y;
            if (pos.indexOf('bottom') === 0) { y = 24; } else { y = s.height - size - 24; }
            if (pos.indexOf('-c') > 0) { x = (s.width - tw) / 2; } else { x = s.width - tw - 28; }
            p.drawText(num, { x: x, y: y, size: size, font: font, color: col });
          });
          var blob = new Blob([await doc.save()], { type: 'application/pdf' });
          res.innerHTML = '<div class="result-item"><span>已添加页码到 ' + idx.length + ' 页 · ' + fmtSize(blob.size) + '</span><button class="dl" data-f="numbered.pdf">下载</button></div>';
          res.querySelector('.dl').onclick = function () { download(blob, saveName(files[0].name, '-numbered.pdf')); };
        } catch (e) { res.innerHTML = '<div class="err-box">处理失败：' + esc(e.message) + '</div>'; }
        btn.disabled = false;
      };
    });

  def('pages', 'removeBlank', '移除空白页', '自动检测并删除空白页', '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14"/><path d="M10 9v6M14 9v6"/>',
    '<div class="panel"><div class="field"><label>选择 PDF</label><div id="rbZ"></div></div>' +
    '<div class="field"><label>空白判定阈值 <span class="hint">默认 2%（低于此的非白内容即视为空白）</span></label><input type="number" id="rbT" value="2" min="0.1" max="30" step="0.5"></div>' +
    '<button class="btn btn-primary" id="rbRun">检测并移除</button><div id="rbRes"></div></div>',
    function (b) {
      var up = UploadZone({ accept: '.pdf', main: '点击选择 PDF' });
      el('rbZ').appendChild(up);
      el('rbRun').onclick = async function () {
        var res = el('rbRes'); res.innerHTML = '';
        var files = up.files(); if (!files.length) { res.innerHTML = '<div class="err-box">请先选择 PDF</div>'; return; }
        var btn = el('rbRun'); btn.disabled = true;
        var prog = Progress(); res.appendChild(prog);
        try {
          var bytes = await readFileAsBytes(files[0]);
          var pdf = await pdfjs.getDocument({ data: bytes }).promise;
          var th = (parseFloat(el('rbT').value) || 2) / 100;
          var blankIdx = [];
          for (var i = 0; i < pdf.numPages; i++) {
            prog.show((i / pdf.numPages) * 90, '检测第 ' + (i + 1) + ' / ' + pdf.numPages + ' 页…');
            var page = await pdf.getPage(i + 1);
            var vp = page.getViewport({ scale: 0.4 });
            var c = document.createElement('canvas'); c.width = Math.max(1, Math.round(vp.width)); c.height = Math.max(1, Math.round(vp.height));
            var ctx = c.getContext('2d');
            await page.render({ canvasContext: ctx, viewport: vp }).promise;
            var d = ctx.getImageData(0, 0, c.width, c.height).data;
            var nonWhite = 0, total = c.width * c.height;
            for (var j = 0; j < d.length; j += 4) {
              if (!(d[j] > 246 && d[j + 1] > 246 && d[j + 2] > 246 && d[j + 3] > 180)) nonWhite++;
            }
            if (nonWhite / total < th) blankIdx.push(i);
          }
          prog.hide();
          if (!blankIdx.length) { res.innerHTML = '<div class="result-item"><span>未检测到空白页</span></div>'; return; }
          var doc = await PDFDocument.load(bytes);
          var keep = allIdx(doc.getPageCount()).filter(function (x) { return blankIdx.indexOf(x) < 0; });
          var out = await PDFDocument.create();
          var pages = await out.copyPages(doc, keep);
          pages.forEach(function (p) { out.addPage(p); });
          var blob = new Blob([await out.save()], { type: 'application/pdf' });
          res.innerHTML = '<div class="result-item"><span>已移除 ' + blankIdx.length + ' 个空白页，保留 ' + keep.length + ' 页 · ' + fmtSize(blob.size) + '</span><button class="dl" data-f="noblank.pdf">下载</button></div>';
          res.querySelector('.dl').onclick = function () { download(blob, saveName(files[0].name, '-noblank.pdf')); };
        } catch (e) { prog.hide(); res.innerHTML = '<div class="err-box">处理失败：' + esc(e.message) + '</div>'; }
        btn.disabled = false;
      };
    });

  def('pages', 'splitDouble', '拆分对开页', '把横向对开页拆成左右两页', '<path d="M12 3v18"/><path d="M3 7h4v10H3z"/><path d="M17 7h4v10h-4z"/>',
    '<div class="panel"><div class="field"><label>选择 PDF</label><div id="sdZ"></div></div>' +
    '<div class="field"><label>适用范围</label><select id="sdAll"><option value="all">所有页面</option><option value="wide">仅宽高比大于 1.2 的横向页</option></select></div>' +
    '<button class="btn btn-primary" id="sdRun">拆分</button><div id="sdRes"></div></div>',
    function (b) {
      var up = UploadZone({ accept: '.pdf', main: '点击选择 PDF' });
      el('sdZ').appendChild(up);
      el('sdRun').onclick = async function () {
        var res = el('sdRes'); res.innerHTML = '';
        var files = up.files(); if (!files.length) { res.innerHTML = '<div class="err-box">请先选择 PDF</div>'; return; }
        var btn = el('sdRun'); btn.disabled = true;
        try {
          var bytes = await readFileAsBytes(files[0]);
          var doc = await PDFDocument.load(bytes);
          var mode = el('sdAll').value;
          var out = await PDFDocument.create();
          var srcPages = doc.getPages();
          for (var pi = 0; pi < srcPages.length; pi++) {
            var p = srcPages[pi];
            var s = p.getSize();
            if (mode === 'wide' && s.width / s.height <= 1.2) { var one = await copyPageAt(doc, pi, out); out.addPage(one); continue; }
            var halfW = s.width / 2;
            var l = await copyPageAt(doc, pi, out);
            l.setCropBox(0, 0, halfW, s.height); l.setSize(halfW, s.height);
            var r = await copyPageAt(doc, pi, out);
            r.setCropBox(halfW, 0, halfW, s.height); r.setSize(halfW, s.height);
            out.addPage(l); out.addPage(r);
          }
          var blob = new Blob([await out.save()], { type: 'application/pdf' });
          res.innerHTML = '<div class="result-item"><span>已拆分为 ' + out.getPageCount() + ' 页 · ' + fmtSize(blob.size) + '</span><button class="dl" data-f="splitdouble.pdf">下载</button></div>';
          res.querySelector('.dl').onclick = function () { download(blob, saveName(files[0].name, '-splitdouble.pdf')); };
        } catch (e) { res.innerHTML = '<div class="err-box">处理失败：' + esc(e.message) + '</div>'; }
        btn.disabled = false;
      };
    });

  // 辅助：把源文档第 i 页复制为新页对象
  function copyPageAt(doc, i, out) {
    return out.copyPages(doc, [i]).then(function (ps) { return ps[0]; });
  }

  def('pages', 'nup', '多页排版', '把多页合并排到一页（2/4/6 合一）', '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
    '<div class="panel"><div class="field"><label>选择 PDF</label><div id="nuZ"></div></div>' +
    '<div class="row"><div class="field"><label>每页张数</label><select id="nuN"><option value="2">2 合一（左右）</option><option value="4">4 合一（田字格）</option><option value="6">6 合一（3×2）</option></select></div>' +
    '<div class="field"><label>输出方向</label><select id="nuOr"><option value="landscape">横向</option><option value="portrait">纵向</option></select></div></div>' +
    '<button class="btn btn-primary" id="nuRun">排版</button><div id="nuRes"></div></div>',
    function (b) {
      var up = UploadZone({ accept: '.pdf', main: '点击选择 PDF' });
      el('nuZ').appendChild(up);
      el('nuRun').onclick = async function () {
        var res = el('nuRes'); res.innerHTML = '';
        var files = up.files(); if (!files.length) { res.innerHTML = '<div class="err-box">请先选择 PDF</div>'; return; }
        var btn = el('nuRun'); btn.disabled = true;
        var prog = Progress(); res.appendChild(prog);
        try {
          var bytes = await readFileAsBytes(files[0]);
          var pdf = await pdfjs.getDocument({ data: bytes }).promise;
          var n = pdf.numPages;
          var per = parseInt(el('nuN').value) || 4;
          var orient = el('nuOr').value;
          var cols = per === 2 ? 2 : (per === 4 ? 2 : 3);
          var rows = Math.ceil(per / cols);
          var sheetW = orient === 'landscape' ? 842 : 595, sheetH = orient === 'landscape' ? 595 : 842;
          var cellW = sheetW / cols, cellH = sheetH / rows;
          var out = await PDFDocument.create();
          for (var g = 0; g < n; g += per) {
            prog.show((g / n) * 90, '排版第 ' + (g + 1) + ' 组…');
            var canvas = document.createElement('canvas'); canvas.width = sheetW; canvas.height = sheetH;
            var ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, sheetW, sheetH);
            var count = Math.min(per, n - g);
            for (var k = 0; k < count; k++) {
              var page = await pdf.getPage(g + k + 1);
              var vp = page.getViewport({ scale: 1 });
              var scale = Math.min(cellW / vp.width, cellH / vp.height);
              var vp2 = page.getViewport({ scale: scale * 0.95 });
              var pc = document.createElement('canvas'); pc.width = vp2.width; pc.height = vp2.height;
              await page.render({ canvasContext: pc.getContext('2d'), viewport: vp2 }).promise;
              var col = k % cols, row = Math.floor(k / cols);
              ctx.drawImage(pc, col * cellW + (cellW - vp2.width) / 2, row * cellH + (cellH - vp2.height) / 2);
            }
            var blob = dataUrlToBlob(canvas.toDataURL('image/png'));
            var img = await out.embedPng(new Uint8Array(await blob.arrayBuffer()));
            out.addPage([sheetW, sheetH]).drawImage(img, { x: 0, y: 0, width: sheetW, height: sheetH });
          }
          prog.hide();
          var ob = new Blob([await out.save()], { type: 'application/pdf' });
          res.innerHTML = '<div class="result-item"><span>排版完成 · ' + out.getPageCount() + ' 页 · ' + fmtSize(ob.size) + '</span><button class="dl" data-f="layout.pdf">下载</button></div>';
          res.querySelector('.dl').onclick = function () { download(ob, saveName(files[0].name, '-layout.pdf')); };
        } catch (e) { prog.hide(); res.innerHTML = '<div class="err-box">处理失败：' + esc(e.message) + '</div>'; }
        btn.disabled = false;
      };
    });

  def('pages', 'overlay', '叠加 PDF', '把另一个 PDF 叠加到当前 PDF 每页上', '<path d="M4 4h12v12H4z"/><path d="M8 8h12v12H8z"/>',
    '<div class="panel"><div class="field"><label>底稿 PDF</label><div id="ovA"></div></div>' +
    '<div class="field"><label>叠加 PDF（可作水印页/印章）</label><div id="ovB"></div></div>' +
    '<div class="row"><div class="field"><label>透明度 <span class="hint">0-1</span></label><input type="number" id="ovO" value="0.8" min="0.1" max="1" step="0.05"></div>' +
    '<div class="field"><label>叠加页 <span class="hint">用叠加PDF的第几页</span></label><input type="number" id="ovPg" value="1" min="1"></div></div>' +
    '<button class="btn btn-primary" id="ovRun">叠加</button><div id="ovRes"></div></div>',
    function (b) {
      var upA = UploadZone({ accept: '.pdf', main: '选择底稿 PDF' });
      var upB = UploadZone({ accept: '.pdf', main: '选择要叠加的 PDF' });
      el('ovA').appendChild(upA); el('ovB').appendChild(upB);
      el('ovRun').onclick = async function () {
        var res = el('ovRes'); res.innerHTML = '';
        var fa = upA.files(), fb = upB.files();
        if (!fa.length || !fb.length) { res.innerHTML = '<div class="err-box">请上传底稿和叠加两个 PDF</div>'; return; }
        var btn = el('ovRun'); btn.disabled = true;
        try {
          var base = await PDFDocument.load(await readFileAsBytes(fa[0]));
          var top = await PDFDocument.load(await readFileAsBytes(fb[0]));
          var pgIdx = (parseInt(el('ovPg').value) || 1) - 1;
          if (pgIdx < 0 || pgIdx >= top.getPageCount()) throw new Error('叠加页码超出范围（共 ' + top.getPageCount() + ' 页）');
          var topPages = await base.embedPdf(top, [pgIdx]);
          var opacity = parseFloat(el('ovO').value) || 0.8;
          base.getPages().forEach(function (p, i) {
            p.drawPage(topPages[0], { x: 0, y: 0, width: p.getWidth(), height: p.getHeight(), opacity: opacity });
          });
          var blob = new Blob([await base.save()], { type: 'application/pdf' });
          res.innerHTML = '<div class="result-item"><span>已叠加到 ' + base.getPageCount() + ' 页 · ' + fmtSize(blob.size) + '</span><button class="dl" data-f="overlaid.pdf">下载</button></div>';
          res.querySelector('.dl').onclick = function () { download(blob, saveName(fa[0].name, '-overlaid.pdf')); };
        } catch (e) { res.innerHTML = '<div class="err-box">处理失败：' + esc(e.message) + '</div>'; }
        btn.disabled = false;
      };
    });

  // ============ 安全保护 ============
  def('security', 'watermark', '添加水印', '给每一页添加文字水印', IC.watermark,
    '<div class="panel"><div class="field"><label>选择 PDF</label><div id="wmz"></div></div>' +
    '<div class="field"><label>水印文字</label><input type="text" id="wmT" placeholder="如：内部资料 严禁外传"></div>' +
    '<div class="row"><div class="field"><label>字号</label><input type="number" id="wmS" value="48" min="10" max="200"></div>' +
    '<div class="field"><label>透明度 <span class="hint">0-1</span></label><input type="number" id="wmO" value="0.25" min="0.05" max="1" step="0.05"></div></div>' +
    '<div class="row"><div class="field"><label>颜色</label><input type="color" id="wmC" value="#999999"></div>' +
    '<div class="field"><label>倾斜角度</label><input type="number" id="wmA" value="-30" min="-90" max="90"></div></div>' +
    '<button class="btn btn-primary" id="wmRun">添加水印</button><div id="wmRes"></div></div>',
    function (b) {
      var up = UploadZone({ accept: '.pdf', main: '点击选择 PDF' });
      el('wmz').appendChild(up);
      el('wmRun').onclick = async function () {
        var res = el('wmRes'); res.innerHTML = '';
        var files = up.files(); if (!files.length) { res.innerHTML = '<div class="err-box">请先选择 PDF</div>'; return; }
        var text = el('wmT').value.trim();
        if (!text) { res.innerHTML = '<div class="err-box">请输入水印文字</div>'; return; }
        var btn = el('wmRun'); btn.disabled = true;
        try {
          var bytes = await readFileAsBytes(files[0]);
          var doc = await PDFDocument.load(bytes);
          var font = await embedCjk(doc);
          var size = parseFloat(el('wmS').value) || 48;
          var opacity = parseFloat(el('wmO').value) || 0.25;
          var ang = parseFloat(el('wmA').value) || -30;
          var hex = el('wmC').value.replace('#', '');
          var col = rgb(parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255);
          var pages = doc.getPages();
          pages.forEach(function (page) {
            var w = page.getWidth(), h = page.getHeight();
            var tw = font.widthOfTextAtSize(text, size);
            var th = font.heightAtSize(size);
            page.drawText(text, {
              x: (w - tw) / 2, y: (h - th) / 2,
              size: size, font: font, color: col, opacity: opacity,
              rotate: degrees(ang)
            });
          });
          var blob = new Blob([await doc.save()], { type: 'application/pdf' });
          res.innerHTML = '<div class="result-item"><span>已添加水印 · ' + pages.length + ' 页 · ' + fmtSize(blob.size) + '</span><button class="dl" data-f="watermarked.pdf">下载</button></div>';
          res.querySelector('.dl').onclick = function () { download(blob, saveName(files[0].name, '-watermarked.pdf')); };
        } catch (e) { res.innerHTML = '<div class="err-box">处理失败：' + esc(e.message) + '</div>'; }
        btn.disabled = false;
      };
    });

  def('edit', 'metadata', '编辑元数据', '修改 PDF 的标题、作者、主题等属性', '<path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z"/><path d="M18 15l1 2.5L21.5 18 19 19l-1 2.5L17 19l-2.5-1L17 17.5z"/>',
    '<div class="panel"><div class="field"><label>选择 PDF</label><div id="mdZ"></div></div>' +
    '<div class="field"><label>标题</label><input type="text" id="mdT" placeholder="留空则不变更"></div>' +
    '<div class="field"><label>作者</label><input type="text" id="mdA" placeholder="留空则不变更"></div>' +
    '<div class="field"><label>主题</label><input type="text" id="mdS" placeholder="留空则不变更"></div>' +
    '<div class="field"><label>关键词 <span class="hint">逗号分隔</span></label><input type="text" id="mdK" placeholder="如 pdf,合同"></div>' +
    '<button class="btn btn-primary" id="mdRun">保存</button><div id="mdRes"></div></div>',
    function (b) {
      var up = UploadZone({ accept: '.pdf', main: '点击选择 PDF' });
      el('mdZ').appendChild(up);
      el('mdRun').onclick = async function () {
        var res = el('mdRes'); res.innerHTML = '';
        var files = up.files(); if (!files.length) { res.innerHTML = '<div class="err-box">请先选择 PDF</div>'; return; }
        var btn = el('mdRun'); btn.disabled = true;
        try {
          var doc = await PDFDocument.load(await readFileAsBytes(files[0]));
          var t = el('mdT').value.trim(), a = el('mdA').value.trim(), s = el('mdS').value.trim(), k = el('mdK').value.trim();
          if (t) doc.setTitle(t);
          if (a) doc.setAuthor(a);
          if (s) doc.setSubject(s);
          if (k) doc.setKeywords(k.split(/[,，]/).map(function (x) { return x.trim(); }).filter(function (x) { return x; }));
          var blob = new Blob([await doc.save()], { type: 'application/pdf' });
          res.innerHTML = '<div class="result-item"><span>元数据已更新 · ' + fmtSize(blob.size) + '</span><button class="dl" data-f="meta.pdf">下载</button></div>';
          res.querySelector('.dl').onclick = function () { download(blob, saveName(files[0].name, '-meta.pdf')); };
        } catch (e) { res.innerHTML = '<div class="err-box">处理失败：' + esc(e.message) + '</div>'; }
        btn.disabled = false;
      };
    });

  def('edit', 'info', '获取 PDF 信息', '查看 PDF 的页数、属性与时间等元信息', '<path d="M9 9h1M9 13h1M13 9h3M13 13h3"/><circle cx="12" cy="12" r="9"/>',
    '<div class="panel"><div class="field"><label>选择 PDF</label><div id="ifZ"></div></div>' +
    '<button class="btn btn-primary" id="ifRun">读取信息</button><div id="ifRes"></div></div>',
    function (b) {
      var up = UploadZone({ accept: '.pdf', main: '点击选择 PDF' });
      el('ifZ').appendChild(up);
      el('ifRun').onclick = async function () {
        var res = el('ifRes'); res.innerHTML = '';
        var files = up.files(); if (!files.length) { res.innerHTML = '<div class="err-box">请先选择 PDF</div>'; return; }
        var btn = el('ifRun'); btn.disabled = true;
        try {
          var doc = await PDFDocument.load(await readFileAsBytes(files[0]));
          function d(v) { return v instanceof Date ? v.toLocaleString('zh-CN') : (v || '—'); }
          var rows = [
            ['文件', files[0].name], ['页数', String(doc.getPageCount())],
            ['标题', d(doc.getTitle())], ['作者', d(doc.getAuthor())],
            ['主题', d(doc.getSubject())], ['关键词', d(doc.getKeywords())],
            ['创建者', d(doc.getCreator())], ['生成器', d(doc.getProducer())],
            ['创建时间', d(doc.getCreationDate())], ['修改时间', d(doc.getModificationDate())]
          ];
          var h = '<div style="font-size:14px;line-height:2">';
          rows.forEach(function (r) { h += '<div><b>' + r[0] + '：</b>' + esc(r[1]) + '</div>'; });
          h += '</div>';
          res.innerHTML = '<div class="result-item">' + h + '</div>';
        } catch (e) { res.innerHTML = '<div class="err-box">读取失败：' + esc(e.message) + '</div>'; }
        btn.disabled = false;
      };
    });

  def('edit', 'addImage', '添加图片到页面', '在指定位置插入一张图片', '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><circle cx="9" cy="13" r="1.5"/><path d="M16 19l-4-5-3 3"/>',
    '<div class="panel"><div class="row"><div class="field"><label>选择 PDF</label><div id="aiZ"></div></div>' +
    '<div class="field"><label>选择图片</label><div id="aiImg"></div></div></div>' +
    '<div class="row"><div class="field"><label>目标页码</label><input type="number" id="aiPg" value="1" min="1"></div>' +
    '<div class="field"><label>图片宽度占页 %</label><input type="number" id="aiW" value="50" min="5" max="100"></div></div>' +
    '<div class="row"><div class="field"><label>水平位置</label><select id="aiH"><option value="center">居中</option><option value="left">靠左</option><option value="right">靠右</option></select></div>' +
    '<div class="field"><label>垂直位置</label><select id="aiV"><option value="center">居中</option><option value="top">顶部</option><option value="bottom">底部</option></select></div></div>' +
    '<button class="btn btn-primary" id="aiRun">插入图片</button><div id="aiRes"></div></div>',
    function (b) {
      var up = UploadZone({ accept: '.pdf', main: '选择 PDF' });
      var upImg = UploadZone({ accept: 'image/png,image/jpeg', main: '选择图片' });
      el('aiZ').appendChild(up); el('aiImg').appendChild(upImg);
      el('aiRun').onclick = async function () {
        var res = el('aiRes'); res.innerHTML = '';
        var fa = up.files(), fi = upImg.files();
        if (!fa.length || !fi.length) { res.innerHTML = '<div class="err-box">请选择 PDF 和图片</div>'; return; }
        var btn = el('aiRun'); btn.disabled = true;
        try {
          var doc = await PDFDocument.load(await readFileAsBytes(fa[0]));
          var ib = await readFileAsBytes(fi[0]);
          var img = /\.png$/i.test(fi[0].name) ? await doc.embedPng(ib) : await doc.embedJpg(ib);
          var pgIdx = (parseInt(el('aiPg').value) || 1) - 1;
          var page = doc.getPage(Math.max(0, Math.min(pgIdx, doc.getPageCount() - 1)));
          var pw = page.getWidth(), ph = page.getHeight();
          var w = pw * ((parseFloat(el('aiW').value) || 50) / 100);
          var h = img.height * (w / img.width);
          var hpos = el('aiH').value, vpos = el('aiV').value;
          var x = hpos === 'left' ? 20 : (hpos === 'right' ? pw - w - 20 : (pw - w) / 2);
          var y = vpos === 'top' ? ph - h - 20 : (vpos === 'bottom' ? 20 : (ph - h) / 2);
          page.drawImage(img, { x: x, y: y, width: w, height: h });
          var blob = new Blob([await doc.save()], { type: 'application/pdf' });
          res.innerHTML = '<div class="result-item"><span>图片已插入第 ' + (page + 1 ? pgIdx + 1 : pgIdx + 1) + ' 页 · ' + fmtSize(blob.size) + '</span><button class="dl" data-f="withimg.pdf">下载</button></div>';
          res.querySelector('.dl').onclick = function () { download(blob, saveName(fa[0].name, '-img.pdf')); };
        } catch (e) { res.innerHTML = '<div class="err-box">处理失败：' + esc(e.message) + '</div>'; }
        btn.disabled = false;
      };
    });

  def('edit', 'stamp', '添加印章', '把图片印章（PNG）叠加到每一页', '<circle cx="12" cy="12" r="9"/><path d="M8 9h8M8 12h8M8 15h5"/>',
    '<div class="panel"><div class="row"><div class="field"><label>选择 PDF</label><div id="stZ"></div></div>' +
    '<div class="field"><label>选择印章图（建议透明底 PNG）</label><div id="stImg"></div></div></div>' +
    '<div class="row"><div class="field"><label>印章宽度占页 %</label><input type="number" id="stW" value="30" min="5" max="80"></div>' +
    '<div class="field"><label>透明度 <span class="hint">0-1</span></label><input type="number" id="stO" value="0.7" min="0.1" max="1" step="0.05"></div></div>' +
    '<button class="btn btn-primary" id="stRun">加盖印章</button><div id="stRes"></div></div>',
    function (b) {
      var up = UploadZone({ accept: '.pdf', main: '选择 PDF' });
      var upImg = UploadZone({ accept: 'image/png,image/jpeg', main: '选择印章图片' });
      el('stZ').appendChild(up); el('stImg').appendChild(upImg);
      el('stRun').onclick = async function () {
        var res = el('stRes'); res.innerHTML = '';
        var fa = up.files(), fi = upImg.files();
        if (!fa.length || !fi.length) { res.innerHTML = '<div class="err-box">请选择 PDF 和印章图片</div>'; return; }
        var btn = el('stRun'); btn.disabled = true;
        try {
          var doc = await PDFDocument.load(await readFileAsBytes(fa[0]));
          var ib = await readFileAsBytes(fi[0]);
          var img = /\.png$/i.test(fi[0].name) ? await doc.embedPng(ib) : await doc.embedJpg(ib);
          var wPct = (parseFloat(el('stW').value) || 30) / 100;
          var opacity = parseFloat(el('stO').value) || 0.7;
          doc.getPages().forEach(function (p) {
            var pw = p.getWidth(), ph = p.getHeight();
            var w = pw * wPct, h = img.height * (w / img.width);
            p.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h, opacity: opacity });
          });
          var blob = new Blob([await doc.save()], { type: 'application/pdf' });
          res.innerHTML = '<div class="result-item"><span>已加盖到 ' + doc.getPageCount() + ' 页 · ' + fmtSize(blob.size) + '</span><button class="dl" data-f="stamped.pdf">下载</button></div>';
          res.querySelector('.dl').onclick = function () { download(blob, saveName(fa[0].name, '-stamped.pdf')); };
        } catch (e) { res.innerHTML = '<div class="err-box">处理失败：' + esc(e.message) + '</div>'; }
        btn.disabled = false;
      };
    });

  def('edit', 'flatten', '扁平化表单', '把 PDF 表单字段压平成静态内容', '<rect x="4" y="6" width="16" height="12" rx="2"/><path d="M8 10h8M8 13h5"/>',
    '<div class="panel"><div class="field"><label>选择 PDF（含表单）</label><div id="flZ"></div></div>' +
    '<button class="btn btn-primary" id="flRun">扁平化</button><div id="flRes"></div></div>',
    function (b) {
      var up = UploadZone({ accept: '.pdf', main: '点击选择 PDF' });
      el('flZ').appendChild(up);
      el('flRun').onclick = async function () {
        var res = el('flRes'); res.innerHTML = '';
        var files = up.files(); if (!files.length) { res.innerHTML = '<div class="err-box">请先选择 PDF</div>'; return; }
        var btn = el('flRun'); btn.disabled = true;
        try {
          var doc = await PDFDocument.load(await readFileAsBytes(files[0]));
          var form = doc.getForm();
          if (form.flatten) form.flatten();
          var blob = new Blob([await doc.save()], { type: 'application/pdf' });
          res.innerHTML = '<div class="result-item"><span>表单已扁平化 · ' + fmtSize(blob.size) + '</span><button class="dl" data-f="flattened.pdf">下载</button></div>';
          res.querySelector('.dl').onclick = function () { download(blob, saveName(files[0].name, '-flat.pdf')); };
        } catch (e) { res.innerHTML = '<div class="err-box">处理失败：' + esc(e.message) + '</div>'; }
        btn.disabled = false;
      };
    });

  // ============ 文本 & OCR ============
  def('text', 'extractText', '提取文本', '提取 PDF 中的可编辑文本', IC.text,
    '<div class="panel"><div class="field"><label>选择 PDF</label><div id="txZ"></div></div>' +
    '<div class="field"><label>页码范围 <span class="hint">留空 = 全部</span></label><input type="text" id="txR" placeholder="如 1-5"></div>' +
    '<button class="btn btn-primary" id="txRun">提取文本</button><div id="txRes"></div></div>',
    function (b) {
      var up = UploadZone({ accept: '.pdf', main: '点击选择 PDF' });
      el('txZ').appendChild(up);
      el('txRun').onclick = async function () {
        var res = el('txRes'); res.innerHTML = '';
        var files = up.files(); if (!files.length) { res.innerHTML = '<div class="err-box">请先选择 PDF</div>'; return; }
        var btn = el('txRun'); btn.disabled = true;
        try {
          var bytes = await readFileAsBytes(files[0]);
          var pdf = await pdfjs.getDocument({ data: bytes }).promise;
          var range = el('txR').value.trim();
          var idx = range ? parseRanges(range, pdf.numPages)[0] || [] : allIdx(pdf.numPages);
          var out = [];
          for (var i = 0; i < idx.length; i++) {
            var page = await pdf.getPage(idx[i] + 1);
            var tc = await page.getTextContent();
            var line = tc.items.map(function (it) { return it.str || ''; }).join(' ');
            out.push('—— 第 ' + (idx[i] + 1) + ' 页 ——\n' + line);
          }
          var text = out.join('\n\n');
          var blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
          res.innerHTML = '<div class="field"><div class="hint">提取到 ' + text.length + ' 字符</div></div><pre class="ocr-out"></pre>' +
            '<div style="margin-top:10px"><button class="btn btn-ghost" id="txDl">下载为 .txt</button></div>';
          res.querySelector('.ocr-out').textContent = text;
          res.querySelector('#txDl').onclick = function () { download(blob, saveName(files[0].name, '-text.txt')); };
        } catch (e) { res.innerHTML = '<div class="err-box">处理失败：' + esc(e.message) + '</div>'; }
        btn.disabled = false;
      };
    });

  def('text', 'ocr', 'OCR 识别', '识别扫描件 / 图片中的文字（中英文）', IC.ocr,
    '<div class="panel"><div class="field"><label>上传图片 或 PDF 扫描件</label><div id="ocZ"></div></div>' +
    '<div class="field"><label>识别语言</label><select id="ocL"><option value="chi_sim+eng">中文 + 英文</option><option value="chi_sim">仅中文</option><option value="eng">仅英文</option></select></div>' +
    '<button class="btn btn-primary" id="ocRun">开始识别</button><div id="ocRes"></div></div>',
    function (b) {
      var up = UploadZone({ accept: 'image/*,.pdf', main: '点击选择图片或 PDF' });
      el('ocZ').appendChild(up);
      el('ocRun').onclick = async function () {
        var res = el('ocRes'); res.innerHTML = '';
        var files = up.files(); if (!files.length) { res.innerHTML = '<div class="err-box">请先上传文件</div>'; return; }
        var btn = el('ocRun'); btn.disabled = true;
        var prog = Progress(); res.appendChild(prog);
        var worker = null;
        try {
          prog.show(5, '正在加载识别引擎…');
          worker = await Tesseract.createWorker({
            workerPath: new URL('libs/tesseract/worker.min.js', BASE).href,
            corePath: new URL('libs/tesseract/core/', BASE).href,
            langPath: new URL('libs/tesseract/lang/', BASE).href,
            cacheMethod: 'none',
            logger: function (m) { if (m.status === 'recognizing text') prog.show(10 + m.progress * 85, '识别中 ' + Math.round(m.progress * 100) + '%'); }
          });
          await worker.loadLanguage(el('ocL').value);
          await worker.initialize(el('ocL').value);

          var f = files[0];
          var isPdf = /\.pdf$/i.test(f.name);
          var target;
          if (isPdf) {
            var bytes = await readFileAsBytes(f);
            var pdf = await pdfjs.getDocument({ data: bytes }).promise;
            var page = await pdf.getPage(1);
            var vp = page.getViewport({ scale: 2 });
            var canvas = document.createElement('canvas');
            canvas.width = vp.width; canvas.height = vp.height;
            await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
            target = canvas;
          } else {
            target = f;
          }
          var result = await worker.recognize(target);
          var text = result.data.text || '';
          prog.hide();
          res.innerHTML = '<div class="field"><div class="hint">识别完成 · ' + text.length + ' 字符</div></div><pre class="ocr-out"></pre>' +
            '<div style="margin-top:10px"><button class="btn btn-ghost" id="ocDl">下载为 .txt</button></div>';
          res.querySelector('.ocr-out').textContent = text;
          res.querySelector('#ocDl').onclick = function () { download(new Blob([text], { type: 'text/plain;charset=utf-8' }), saveName(f.name, '-ocr.txt')); };
        } catch (e) { prog.hide(); res.innerHTML = '<div class="err-box">识别失败：' + esc(e.message) + '</div>'; }
        if (worker) { try { await worker.terminate(); } catch (e2) {} }
        btn.disabled = false;
      };
    });

  // ---------- 辅助：解析页码范围 ----------
  function allIdx(n) { var a = []; for (var i = 0; i < n; i++) a.push(i); return a; }
  function parseRanges(str, total) {
    var ranges = [];
    str.split(/[,，;；]/).forEach(function (part) {
      part = part.trim(); if (!part) return;
      var m = part.match(/^(\d+)\s*[-—~]\s*(\d+)$/);
      var arr;
      if (m) {
        var s = parseInt(m[1], 10), e = parseInt(m[2], 10);
        if (s < 1 || e > total || s > e) throw new Error('范围 ' + part + ' 超出（共 ' + total + ' 页）');
        arr = []; for (var i = s; i <= e; i++) arr.push(i - 1);
      } else {
        var n = parseInt(part, 10);
        if (isNaN(n) || n < 1 || n > total) throw new Error('页码 ' + part + ' 超出（共 ' + total + ' 页）');
        arr = [n - 1];
      }
      ranges.push(arr);
    });
    if (!ranges.length) throw new Error('请输入有效的页码范围');
    return ranges;
  }
  function dataUrlToBlob(dataUrl) {
    var arr = dataUrl.split(',');
    var mime = arr[0].match(/data:([^;]+)/)[1];
    var bin = atob(arr[1]);
    var u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Blob([u8], { type: mime });
  }

  // ---------- 渲染 ----------
  var CAT_LABEL = { convert: '转换', pages: '页面操作', security: '安全保护', edit: '编辑', text: '文本 & OCR' };
  function renderCards() {
    var map = { home: [], convert: [], pages: [], security: [], edit: [], text: [] };
    TOOLS.forEach(function (t) { map.home.push(t); map[t.cat].push(t); });
    Object.keys(map).forEach(function (key) {
      var host = el(key === 'home' ? 'toolGrid' : 'grid-' + key);
      if (!host) return;
      host.innerHTML = '';
      map[key].forEach(function (t) {
        var c = document.createElement('div');
        c.className = 'card';
        c.innerHTML = '<div class="card-icon">' + svg(t.icon) + '</div><div class="card-title">' + esc(t.title) + '</div><div class="card-desc">' + esc(t.desc) + '</div>';
        c.onclick = function () { openTool(t.id); };
        host.appendChild(c);
      });
    });
  }

  function openTool(id) {
    var t = TOOLS.filter(function (x) { return x.id === id; })[0];
    if (!t) return;
    // 隐藏所有分类/首页视图
    document.querySelectorAll('.view').forEach(function (v) { v.classList.remove('active'); });
    var panel = el('toolPanel');
    panel.style.display = 'block'; panel.classList.add('active');
    el('toolBody').innerHTML =
      '<div class="tp-head"><div class="tp-title">' + svg(t.icon) + ' ' + esc(t.title) + '</div>' +
      '<div class="tp-desc">' + esc(t.desc) + ' · ' + CAT_LABEL[t.cat] + '</div></div>' + t.html;
    // 更新激活 tab
    document.querySelectorAll('.tab').forEach(function (b) { b.classList.remove('active'); });
    var catBtn = document.querySelector('.tab[data-view="cat-' + t.cat + '"]');
    if (catBtn) catBtn.classList.add('active');
    t.run();
  }

  function showView(name) {
    document.querySelectorAll('.view').forEach(function (v) { v.classList.remove('active'); v.style.display = ''; });
    if (name === 'home') {
      el('toolPanel').style.display = 'none';
      el('view-home').classList.add('active');
    } else {
      el('toolPanel').style.display = 'none';
      var catMap = { 'cat-convert': 'convert', 'cat-pages': 'pages', 'cat-security': 'security', 'cat-edit': 'edit', 'cat-text': 'text' };
      var cat = catMap[name];
      var target = name === 'cat-' + (cat || '') ? el('view-' + name) : null;
      if (target) target.classList.add('active');
      else if (cat) el('view-cat-' + cat).classList.add('active');
      else el('view-home').classList.add('active');
    }
    document.querySelectorAll('.tab').forEach(function (b) { b.classList.toggle('active', b.dataset.view === name); });
    window.scrollTo(0, 0);
  }

  // 初始化
  renderCards();
  el('backBtn').onclick = function () { showView('home'); };
  document.querySelectorAll('.tab').forEach(function (b) {
    b.onclick = function () { showView(b.dataset.view); };
  });

})();
