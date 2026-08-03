import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express, { type NextFunction, type Request, type Response } from "express";
import { ZodError } from "zod";
import { OperatorControl, OperatorInputError } from "./operator-control.js";

export interface OperatorServer {
  url: string;
  close(): Promise<void>;
}

export interface OperatorServerOptions {
  host: string;
  port: number;
  control: OperatorControl;
}

export async function startOperatorServer(
  options: OperatorServerOptions
): Promise<OperatorServer> {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb", type: "application/json" }));

  app.get("/api/operator/status", (_request, response) => {
    response.json(options.control.status());
  });
  app.get("/api/operator/usage", (_request, response) => {
    response.json(options.control.usage());
  });
  app.post("/api/operator/tasks/gather", route((body) => options.control.submitGather(body)));
  app.post("/api/operator/tasks/project", route((body) => options.control.submitProject(body)));
  app.post("/api/operator/tasks/cancel", route((body) => options.control.cancel(body)));
  app.post("/api/operator/plan", route((body) => options.control.requestPlan(body)));
  app.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      _next: NextFunction
    ) => {
      if (error instanceof ZodError) {
        response.status(400).json({
          error: "Invalid operator request",
          issues: error.issues
        });
        return;
      }
      if (error instanceof OperatorInputError) {
        response.status(409).json({ error: error.message });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[operator] ${message}`);
      response.status(500).json({ error: "Operator request failed" });
    }
  );

  const server = await listen(app, options.host, options.port);
  const address = server.address() as AddressInfo;
  const url = `http://${options.host}:${address.port}`;
  console.log(
    `[operator] Local control listening on ${url}`
  );
  return {
    url,
    close: () => closeServer(server)
  };
}

function route(handler: (body: unknown) => object) {
  return (request: Request, response: Response, next: NextFunction): void => {
    try {
      response.json(handler(request.body));
    } catch (error) {
      next(error);
    }
  };
}

function listen(
  app: ReturnType<typeof express>,
  host: string,
  port: number
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.once("error", reject);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
