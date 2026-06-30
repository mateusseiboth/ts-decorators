import {describe, expect, test} from "bun:test";
import {RequiresRole} from "../src/decorators/requiresRole";
import {mockReq, mockRes} from "./_helpers";

describe("@RequiresRole", () => {
  test("permite quando o usuário tem o papel", async () => {
    class Ctrl {
      @RequiresRole("admin")
      async remove(_req: any, res: any) {
        return res.status(200).json({ok: true});
      }
    }
    const res = mockRes({locals: {user: {roles: ["admin"]}}});
    await new Ctrl().remove(mockReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res._body).toEqual({ok: true});
  });

  test("bloqueia (403) quando o papel falta", async () => {
    class Ctrl {
      @RequiresRole(["admin", "fiscal"])
      async aprovar(_req: any, res: any) {
        return res.status(200).json({ok: true});
      }
    }
    const res = mockRes({locals: {user: {roles: ["leitor"]}}});
    await new Ctrl().aprovar(mockReq(), res);
    expect(res.statusCode).toBe(403);
    expect(res._body.code).toBe("FORBIDDEN");
  });

  test("extractor customizado", async () => {
    class Ctrl {
      @RequiresRole("super", {rolesExtractor: (req) => req.headers["x-roles"]?.split(",") ?? []})
      async danger(_req: any, res: any) {
        return res.status(200).json({ok: true});
      }
    }
    const res = mockRes();
    await new Ctrl().danger(mockReq({headers: {"x-roles": "super,admin"}}), res);
    expect(res.statusCode).toBe(200);
  });
});
