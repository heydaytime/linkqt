export function starterDocument({
  name,
  title = name,
}: {
  name: string;
  title?: string;
}) {
  const path = title.trim().toLowerCase().replace(/\s+/g, "-");
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet" />
    <style>
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 28px;
        font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        background:
          radial-gradient(circle at 50% 0%, rgba(34,211,238,.14), transparent 38%),
          linear-gradient(#05070a, #070b10 58%, #05070a);
        color: #d8fff1;
      }
      body::before {
        content: "";
        position: fixed;
        inset: 0;
        pointer-events: none;
        background-image:
          linear-gradient(rgba(255,255,255,.03) 1px, transparent 1px),
          linear-gradient(90deg, rgba(255,255,255,.03) 1px, transparent 1px);
        background-size: 28px 28px;
        mask-image: radial-gradient(circle at 50% 30%, #000, transparent 75%);
      }
      main {
        position: relative;
        width: min(100%, 440px);
        padding: 0 0 18px;
        border: 1px solid #1a3a40;
        background: rgba(7, 11, 16, .94);
        box-shadow: 0 0 0 1px rgba(34,211,238,.12) inset, 0 24px 80px rgba(34,211,238,.1);
      }
      .chrome {
        display: flex;
        align-items: center;
        gap: 7px;
        padding: 12px 14px;
        border-bottom: 1px solid #133;
        color: #4a6;
        font-size: 11px;
      }
      .chrome i {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #133;
      }
      .chrome i:nth-child(1) { background: #f87171; }
      .chrome i:nth-child(2) { background: #fbbf24; }
      .chrome i:nth-child(3) { background: #34d399; }
      .chrome em { margin-left: 8px; font-style: normal; }
      .prompt, .dim, .cursor { margin: 0; padding: 0 18px; }
      .prompt { margin-top: 22px; color: #5b7; font-size: 12px; }
      h1 { margin: 10px 18px 8px; font-size: 28px; font-weight: 600; color: #9ff; letter-spacing: -.04em; }
      .dim { color: #4a6; font-size: 12px; margin-bottom: 18px; }
      nav { border-top: 1px solid #123; }
      a {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        padding: 12px 18px;
        color: #9ff;
        text-decoration: none;
        border-bottom: 1px solid #123;
      }
      a:hover { color: #fff; background: rgba(34,211,238,.06); }
      a span { color: #4a6; font-size: 12px; }
      .cursor { margin-top: 18px; color: #5b7; font-size: 12px; }
      .cursor b {
        display: inline-block;
        width: 8px;
        height: 1em;
        margin-left: 6px;
        background: #9ff;
        vertical-align: -2px;
        animation: blink 1.1s steps(1) infinite;
      }
      @keyframes blink { 50% { opacity: 0; } }
    </style>
  </head>
  <body>
    <main>
      <div class="chrome">
        <i></i><i></i><i></i>
        <em>${name}@linkqt</em>
      </div>
      <p class="prompt">${name}@linkqt ~</p>
      <h1>/${path}</h1>
      <p class="dim"># open a destination</p>
      <nav aria-label="My links">
        <a href="https://www.youtube.com/@${name}">&gt; open youtube <span>@${name}</span></a>
        <a href="https://www.instagram.com/${name}/">&gt; open instagram <span>@${name}</span></a>
        <a href="https://example.com/">&gt; open site <span>example.com</span></a>
      </nav>
      <p class="cursor">${name}@linkqt ~ <b></b></p>
    </main>
  </body>
</html>`;
}

export const STARTER_DOCUMENT = starterDocument({ name: "yourhandle" });
