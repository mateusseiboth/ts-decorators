import type { Router } from "express";

export function registry(router: Router) {
  router.get("/", (req, res) => {
    res.json(req.params);
  });
}
