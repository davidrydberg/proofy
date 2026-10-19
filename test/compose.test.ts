import { describe, expect, it } from "vitest";
import { configSchema } from "../src/config.js";
import { sandboxCompose, subnetFor } from "../src/sandbox/compose.js";

const dirs = { pkg: "/pkg", ca: "/cache/ca", runSetup: "/w/setup", out: "/w/out", e2e: "/repo/e2e", work: "/w/runner", nodeModules: "/w/node_modules" };

function generate(model: Record<string, unknown>, config: Record<string, unknown>, mode: "run" | "dev" = "run") {
  return sandboxCompose({
    model,
    config: configSchema.parse(config),
    mode,
    subnet: "10.210.1.0/24",
    standinIp: "10.210.1.53",
    standinImage: "proofy-standin:test",
    runnerImage: "playwright:test",
    user: "501:20",
    dirs,
  });
}

const MODEL = {
  name: "shop",
  services: {
    web: {
      image: "shop",
      ports: [{ target: 80, published: "8080" }],
      container_name: "shop-web",
      env_file: [{ path: "/repo/.env" }],
      environment: { APP_ENV: "local", KEEP: "yes" },
      networks: { backend: { aliases: ["shop.internal"] } },
      volumes: [{ type: "bind", source: "/repo/src", target: "/var/www" }],
    },
    db: { image: "mariadb:11", networks: { backend: null } },
  },
  networks: { backend: { name: "shop_backend" } },
  volumes: { data: { name: "shop_data" } },
};

describe("sandbox compose", () => {
  it("seals every app service: one internal network, catch-all DNS, no ports, settings from the config only", () => {
    const { compose, notes } = generate(MODEL, { compose: ["compose.yml"], app: { service: "web", port: 80 }, env: { web: { APP_ENV: "sandbox" } } });
    const services = compose.services as Record<string, Record<string, unknown>>;
    const web = services.web!;
    expect(web.ports).toBeUndefined();
    expect(web.container_name).toBeUndefined();
    expect(web.env_file).toBeUndefined();
    expect(web.environment).toEqual({ APP_ENV: "sandbox", KEEP: "yes" });
    expect(web.networks).toEqual({ proofy: { aliases: ["shop.internal"] } });
    expect(web.dns).toEqual(["10.210.1.53"]);
    expect(web.volumes).toContainEqual({ type: "bind", source: "/cache/ca", target: "/proofy", read_only: true });
    expect(web.depends_on).toEqual({ "proofy-standin": { condition: "service_healthy", required: true } });
    expect(services.db!.dns).toEqual(["10.210.1.53"]);
    expect(compose.networks).toEqual({ proofy: { internal: true, ipam: { config: [{ subnet: "10.210.1.0/24" }] } } });
    expect(compose.volumes).toEqual(MODEL.volumes);
    expect(notes).toEqual(["web: env_file ignored, settings come only from e2e/proofy.json env"]);
    expect(services["proofy-runner"]!.profiles).toEqual(["proofy-runner"]);
    expect(services["proofy-runner"]!.user).toBe("501:20");
    expect(services["proofy-standin"]!.user).toBe("501:20");
    expect((services["proofy-runner"]!.environment as Record<string, string>).PROOFY_BASE_URL).toBe("http://web:80/");
    expect(services["proofy-standin"]!.networks).toEqual({ proofy: { ipv4_address: "10.210.1.53" } });
    expect(services["proofy-forward"]).toBeUndefined();
  });

  it("opens host ports only through a forwarder in dev mode", () => {
    const { compose } = generate(MODEL, { compose: ["compose.yml"], app: { service: "web", port: 80 } }, "dev");
    const services = compose.services as Record<string, Record<string, unknown>>;
    expect(services["proofy-forward"]!.networks).toEqual({ proofy: {}, "proofy-host": {} });
    expect(services.web!.networks).toEqual({ proofy: { aliases: ["shop.internal"] } });
    expect((compose.networks as Record<string, unknown>)["proofy-host"]).toEqual({});
  });

  it("refuses network_mode, reserved names and config that names unknown services", () => {
    expect(() => generate({ services: { web: { image: "x", network_mode: "host" } } }, { compose: ["c.yml"] })).toThrow(/network_mode/);
    expect(() => generate({ services: { mailpit: { image: "x" } } }, { compose: ["c.yml"] })).toThrow(/reserved/);
    expect(() => generate(MODEL, { compose: ["c.yml"], app: { service: "api", port: 80 } })).toThrow(/app names service "api"/);
    expect(() => generate(MODEL, { compose: ["c.yml"], env: { worker: {} } })).toThrow(/env names service "worker"/);
    expect(() => generate(MODEL, { compose: ["c.yml"], exec: { cron: { service: "queue", command: ["x"] } } })).toThrow(/exec.cron/);
  });

  it("picks a stable subnet per project and a different one per attempt", () => {
    expect(subnetFor("proofy-shop-run-1", 0)).toEqual(subnetFor("proofy-shop-run-1", 0));
    expect(subnetFor("proofy-shop-run-1", 0).subnet).not.toBe(subnetFor("proofy-shop-run-1", 1).subnet);
    expect(subnetFor("x", 0).standinIp).toMatch(/^10\.2[0-4]\d\.\d+\.53$/);
  });
});
