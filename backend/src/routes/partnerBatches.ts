import { Router, Request, Response } from 'express';
import { validateRequest, partnerBatchSchema } from '../middleware/validator';
import { submitPartnerBatch } from '../services/partnerBatchService';
import { sendInternalError } from '../utils/httpResponses';

const router = Router();

router.post('/', validateRequest(partnerBatchSchema), async (req: Request, res: Response) => {
  try {
    const { batch_no, partner_org, records } = req.body;
    const result = await submitPartnerBatch(batch_no, partner_org, records);

    if (result.success) {
      const statusCode = result.data?.status === 'processed' ? 201 : 200;
      res.status(statusCode).json(result);
      return;
    }

    const statusCode = result.details?.status === 'conflicted' ? 409 : 400;
    res.status(statusCode).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error submitting partner batch');
  }
});

export default router;
