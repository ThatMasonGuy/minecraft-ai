import compression from "compression";
import express from "express";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import type { Bot } from "mineflayer";
import { Server as SocketServer, type Socket } from "socket.io";
import type { ViewerSnapshot } from "./viewer-status.js";

const require = createRequire(import.meta.url);
const { WorldView } = require("prismarine-viewer/viewer") as {
  WorldView: new (
    world: Bot["world"],
    viewDistance: number,
    position: Bot["entity"]["position"],
    emitter: Socket
  ) => {
    init(position: Bot["entity"]["position"]): Promise<void>;
    updatePosition(position: Bot["entity"]["position"]): Promise<void>;
    listenToBot(bot: Bot): void;
    removeListenersFromBot(bot: Bot): void;
  };
};

export interface ViewerServerOptions {
  port: number;
  viewDistance: number;
  maxFps: number;
  maxPixelRatio: number;
  status: () => ViewerSnapshot;
}

export interface ViewerServer {
  close: () => Promise<void>;
}

export function startViewerServer(
  bot: Bot,
  options: ViewerServerOptions
): ViewerServer {
  const app = express();
  const server = http.createServer(app);
  const io = new SocketServer(server, { path: "/socket.io" });
  const dashboardRoot = path.resolve("viewer");
  const prismarineRoot = path.dirname(
    require.resolve("prismarine-viewer/public/index.html")
  );
  let lastWorldEventAt = new Date().toISOString();
  const markWorldActivity = () => {
    lastWorldEventAt = new Date().toISOString();
  };
  bot.on("entityMoved", markWorldActivity);
  bot.on("blockUpdate", markWorldActivity);
  bot.on("time", markWorldActivity);

  app.use(compression());
  app.get("/api/status", (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json({
      ...options.status(),
      world: {
        lastEventAt: lastWorldEventAt
      }
    });
  });
  app.get("/viewer-config.js", (_request, response) => {
    response.type("application/javascript");
    response.setHeader("Cache-Control", "no-store");
    response.send(
      `window.minecraftAiViewerConfig=${JSON.stringify({
        maxFps: options.maxFps,
        maxPixelRatio: options.maxPixelRatio,
        minecraftVersion: bot.version
      })};`
    );
  });
  app.use(express.static(dashboardRoot, { index: "index.html" }));
  app.use(express.static(prismarineRoot, { index: false, maxAge: "1d" }));

  io.on("connection", (socket) => {
    socket.emit("version", bot.version);
    const viewerEmitter = createViewerEmitter(
      socket,
      bot,
      options.viewDistance
    );
    const worldView = new WorldView(
      bot.world,
      options.viewDistance,
      bot.entity.position,
      viewerEmitter
    );
    void worldView.init(bot.entity.position);

    const botPosition = () => {
      socket.emit("position", {
        pos: bot.entity.position,
        yaw: bot.entity.yaw,
        pitch: bot.entity.pitch,
        addMesh: true
      });
      void worldView.updatePosition(bot.entity.position);
    };

    bot.on("move", botPosition);
    worldView.listenToBot(bot);
    botPosition();

    socket.on("disconnect", () => {
      bot.removeListener("move", botPosition);
      worldView.removeListenersFromBot(bot);
    });
  });

  const onError = (error: NodeJS.ErrnoException) => {
    console.error(`[viewer] ${error.message}`);
  };
  server.on("error", onError);
  server.listen(options.port, () => {
    console.log(
      `[viewer] Dashboard running on http://localhost:${options.port} ` +
        `(${options.viewDistance} chunks, ${options.maxFps} FPS, ` +
        `${options.maxPixelRatio}x pixel ratio)`
    );
  });

  return {
    close: async () => {
      await new Promise<void>((resolve) => {
        bot.removeListener("entityMoved", markWorldActivity);
        bot.removeListener("blockUpdate", markWorldActivity);
        bot.removeListener("time", markWorldActivity);
        io.close(() => server.close(() => resolve()));
      });
    }
  };
}

function createViewerEmitter(
  socket: Socket,
  bot: Bot,
  viewDistance: number
): Socket {
  const visibleEntityIds = new Set<number>();
  const radius = viewDistance * 16;

  return new Proxy(socket, {
    get(target, property, receiver) {
      if (property !== "emit") return Reflect.get(target, property, receiver);
      return (event: string, payload: unknown) => {
        if (event !== "entity" || !isEntityPacket(payload)) {
          return target.emit(event, payload);
        }

        if (payload.delete) {
          visibleEntityIds.delete(payload.id);
          return target.emit(event, payload);
        }

        if (!payload.pos) return target.emit(event, payload);
        const visible =
          Math.abs(payload.pos.x - bot.entity.position.x) <= radius &&
          Math.abs(payload.pos.z - bot.entity.position.z) <= radius;

        if (!visible) {
          if (visibleEntityIds.delete(payload.id)) {
            return target.emit(event, { id: payload.id, delete: true });
          }
          return target;
        }

        if (!visibleEntityIds.has(payload.id) && !payload.name) {
          const entity = bot.entities[payload.id];
          if (!entity) return target;
          visibleEntityIds.add(payload.id);
          return target.emit(event, {
            id: entity.id,
            name: entity.name,
            pos: entity.position,
            width: entity.width,
            height: entity.height,
            username: entity.username
          });
        }

        visibleEntityIds.add(payload.id);
        return target.emit(event, payload);
      };
    }
  });
}

function isEntityPacket(
  value: unknown
): value is {
  id: number;
  name?: string;
  delete?: boolean;
  pos?: { x: number; y: number; z: number };
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "number"
  );
}
