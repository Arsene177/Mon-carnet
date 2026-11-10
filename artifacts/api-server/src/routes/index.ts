import { Router, type IRouter } from "express";
import healthRouter from "./health";
import medichainRouter from "./medichain";
import accountRouter from "./account";
import mfaRouter from "./mfa";
import securityRouter from "./security";

const router: IRouter = Router();

router.use(healthRouter);
router.use(medichainRouter);
router.use(accountRouter);
router.use(mfaRouter);
router.use(securityRouter);

export default router;
