# Grafiq

An Excalidraw-style collaborative whiteboard, built from scratch. Custom canvas rendering engine, no drawing libraries, real-time multiplayer over WebSockets.

**[Try it live](https://grafiq.hrdk.dev)** — open it in two tabs side by side and draw.

<!-- Record a 10-15 second GIF of two windows syncing, save it as demo.gif in the repo root, then uncomment this line: -->
<!-- ![Two clients drawing on the same canvas in real time](./demo.gif) -->

## Features

- **Real-time collaboration:** multiple users draw on the same canvas and every change syncs live to everyone in the room
- **Vector shapes:** rectangles, ellipses, lines, freehand strokes and text — all selectable and movable after they're drawn
- **Infinite canvas:** pan and zoom anywhere; your view (pan + zoom) is remembered between sessions
- **Share by link:** send a URL and your collaborator lands directly on your canvas
- **Persistent canvases:** boards are saved server-side, so you can close the tab and pick up where you left off
- **Auth:** sign up / sign in with JWT-based sessions stored in an httpOnly cookie

## How it works

### The rendering engine

There is no Excalidraw, Konva, Fabric or any other canvas library in this repo. Everything on the board is drawn directly with the HTML5 Canvas 2D API.

- Every shape is a plain object in an in-memory scene: type, geometry, style
- On any change the engine clears the canvas and repaints every shape from that list — a straightforward full-scene redraw
- Pointer coordinates run through a viewport transform (`pan` + `scale`), which is what keeps drawing, panning, zooming and hit-testing (clicking a shape to select it) accurate at any zoom level

Writing this by hand instead of importing a library was the point. It forced me to actually understand coordinate systems, hit detection and the redraw loop instead of calling someone else's `draw()`.

### Real-time sync

- A WebSocket server keeps a room per canvas
- Drawing actions travel as small per-shape operations — create, update, delete — each carrying a single serialized shape, never a full-canvas snapshot, so messages stay tiny
- Your own strokes render optimistically the instant you draw. The network round trip only affects when _others_ see them, which lands well under 100ms on a normal connection
- Every operation is persisted server-side in PostgreSQL (via Prisma), so a canvas survives everyone disconnecting and reloads from history

Conflict handling is deliberately simple: last write wins per shape. On a whiteboard two people almost never edit the same shape in the same instant, so CRDT-level machinery would be complexity without payoff at this scale.

### Monorepo layout

Turborepo workspace:

```
apps/
  grafiq-frontend   # Next.js frontend + the canvas rendering engine
  http-backend      # Express REST API — auth, rooms, persistence
  ws-backend        # WebSocket server — real-time room sync
packages/
  db                # Prisma schema + client (PostgreSQL)
  fullstack-common  # shared types used by client and both servers
  ui                # shared React components
```

Shared TypeScript types in `fullstack-common` mean a drawing operation is defined once and used on the client, the REST API and the socket server alike.

## Stack

TypeScript, Next.js, raw Canvas 2D, WebSockets (`ws`), Express, PostgreSQL + Prisma, JWT auth, Turborepo, pnpm.

## Running locally

```bash
git clone https://github.com/HKag01/grafiq
cd grafiq
pnpm install

# create your .env (see below), then generate the Prisma client
pnpm db:generate

pnpm dev
```

You'll need a **PostgreSQL** database — a free [Neon](https://neon.tech) instance works out of the box. Create a `.env` at the repo root with:

```bash
DATABASE_URL=postgresql://user:pass@host/db?sslmode=require
JWT_SECRET=your-strong-secret
EXP_TIME=12h

# server-side URLs
HTTP_URL=http://localhost:3001
WS_URL=ws://localhost:8080
FE_URL=http://localhost:3000

# baked into the frontend at build time
NEXT_PUBLIC_HTTP_URL=http://localhost:3001
NEXT_PUBLIC_WS_URL=ws://localhost:8080
NEXT_PUBLIC_FE_URL=http://localhost:3000

WEBSOCKET_PORT=8080
```

Ports: frontend on `:3000`, REST API on `:3001`, WebSocket server on `:8080`.

## Roadmap

- Live cursors with user presence
- Undo/redo that plays nicely with multiplayer
- Export to PNG/SVG

---

Built by **Hardik Agarwal** · [Portfolio](https://portfolio.hrdk.dev) · [LinkedIn](https://www.linkedin.com/in/hkag01/) · [GitHub](https://github.com/HKag01)
