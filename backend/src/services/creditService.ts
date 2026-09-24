import { Volunteer, ServiceRecord, Complaint, CreditLog, CreditScoreResult } from '../types';
import pool from '../db/pool';

const MIN_CREDIT_SCORE = 0;
const MAX_CREDIT_SCORE = 120;
const CREDIT_LIMIT_THRESHOLD = 30;

export const calculateCreditScore = (
  volunteer: Volunteer,
  recentServices: ServiceRecord[],
  recentComplaints: Complaint[],
  noShowCount: number
): number => {
  let score = 100;

  const serviceBonus = Math.min(volunteer.service_count * 0.5, 10);
  score += serviceBonus;

  if (recentServices.length > 0) {
    const avgRating = recentServices.reduce((sum, s) => sum + s.rating, 0) / recentServices.length;
    const ratingBonus = (avgRating - 3) * 15;
    score += ratingBonus;
  }

  score -= noShowCount * 20;

  const unresolvedComplaints = recentComplaints.filter(c => c.status === 'pending' || c.status === 'resolved').length;
  score -= unresolvedComplaints * 15;

  return Math.max(MIN_CREDIT_SCORE, Math.min(MAX_CREDIT_SCORE, Math.round(score)));
};

export const recalculateCreditScore = async (
  volunteerId: string
): Promise<CreditScoreResult | null> => {
  const client = await pool.connect();

  try {
    const volunteerResult = await client.query(
      'SELECT * FROM volunteers WHERE id = $1',
      [volunteerId]
    );

    if (volunteerResult.rows.length === 0) {
      return null;
    }

    const volunteer = volunteerResult.rows[0] as Volunteer;
    const beforeScore = volunteer.credit_score;

    const servicesResult = await client.query(
      'SELECT * FROM service_records WHERE volunteer_id = $1 ORDER BY recorded_at DESC LIMIT 50',
      [volunteerId]
    );
    const recentServices = servicesResult.rows as ServiceRecord[];

    const complaintsResult = await client.query(
      "SELECT * FROM complaints WHERE volunteer_id = $1 AND status IN ('pending', 'resolved')",
      [volunteerId]
    );
    const recentComplaints = complaintsResult.rows as Complaint[];

    const noShowResult = await client.query(
      'SELECT COUNT(*) as count FROM service_records WHERE volunteer_id = $1 AND is_no_show = true',
      [volunteerId]
    );
    const noShowCount = parseInt(noShowResult.rows[0].count);

    let score = 100;

    const serviceCountBonus = Math.min(volunteer.service_count * 0.5, 10);
    score += serviceCountBonus;

    let averageRating = 0;
    if (recentServices.length > 0) {
      averageRating = recentServices.reduce((sum, s) => sum + s.rating, 0) / recentServices.length;
      const ratingBonus = (averageRating - 3) * 15;
      score += ratingBonus;
    }

    score -= noShowCount * 20;

    const activeComplaintCount = recentComplaints.length;
    score -= activeComplaintCount * 15;

    const afterScore = Math.max(MIN_CREDIT_SCORE, Math.min(MAX_CREDIT_SCORE, Math.round(score)));
    const changeAmount = afterScore - beforeScore;

    const breakdown = {
      baseScore: 100,
      serviceCountBonus: Math.min(volunteer.service_count * 0.5, 10),
      ratingBonus: recentServices.length > 0 ? (averageRating - 3) * 15 : 0,
      noShowPenalty: -noShowCount * 20,
      complaintPenalty: -activeComplaintCount * 15,
      total: afterScore,
      details: {
        serviceCount: volunteer.service_count,
        serviceCountBonus: Math.min(volunteer.service_count * 0.5, 10),
        avgRating: recentServices.length > 0 ? Math.round(averageRating * 100) / 100 : null,
        ratingBonus: recentServices.length > 0 ? (averageRating - 3) * 15 : 0,
        noShowCount,
        noShowPenalty: -noShowCount * 20,
        activeComplaintCount,
        complaintPenalty: -activeComplaintCount * 15,
      },
    };

    if (changeAmount !== 0) {
      await client.query(
        'UPDATE volunteers SET credit_score = $1 WHERE id = $2',
        [afterScore, volunteerId]
      );
    }

    return { beforeScore, afterScore, changeAmount, breakdown };
  } finally {
    client.release();
  }
};

export const isCreditLimited = (creditScore: number): boolean => {
  return creditScore < CREDIT_LIMIT_THRESHOLD;
};

export const logCreditChange = async (
  volunteerId: string,
  changeAmount: number,
  reason: string,
  beforeScore: number,
  afterScore: number,
  relatedId?: string,
  relatedType?: string
): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO credit_logs (volunteer_id, change_amount, reason, before_score, after_score, related_id, related_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [volunteerId, changeAmount, reason, beforeScore, afterScore, relatedId, relatedType]
    );
  } finally {
    client.release();
  }
};

export { CREDIT_LIMIT_THRESHOLD, MIN_CREDIT_SCORE, MAX_CREDIT_SCORE };
