import { ApiResponse, RankingEntry, TrendData } from '../types';
import pool from '../db/pool';
import { messages } from '../constants/messages';

export const getPointsRanking = async (
  limit: number = 100
): Promise<ApiResponse<RankingEntry[]>> => {
  const client = await pool.connect();

  try {
    const result = await client.query(
      `SELECT
        id as volunteer_id,
        name as volunteer_name,
        total_points as score,
        level,
        ROW_NUMBER() OVER (ORDER BY total_points DESC, credit_score DESC) as rank
       FROM volunteers
       WHERE is_active = true
       ORDER BY total_points DESC, credit_score DESC
       LIMIT $1`,
      [limit]
    );

    return {
      success: true,
      data: result.rows,
    };
  } finally {
    client.release();
  }
};

export const getCreditRanking = async (
  limit: number = 100
): Promise<ApiResponse<RankingEntry[]>> => {
  const client = await pool.connect();

  try {
    const result = await client.query(
      `SELECT
        id as volunteer_id,
        name as volunteer_name,
        credit_score as score,
        level,
        ROW_NUMBER() OVER (ORDER BY credit_score DESC, total_points DESC) as rank
       FROM volunteers
       WHERE is_active = true
       ORDER BY credit_score DESC, total_points DESC
       LIMIT $1`,
      [limit]
    );

    return {
      success: true,
      data: result.rows,
    };
  } finally {
    client.release();
  }
};

export const getMyPointsRank = async (
  volunteerId: string
): Promise<ApiResponse<any>> => {
  const client = await pool.connect();

  try {
    const result = await client.query(
      `WITH ranked AS (
        SELECT id, total_points,
               ROW_NUMBER() OVER (ORDER BY total_points DESC, credit_score DESC) as rank
        FROM volunteers
        WHERE is_active = true
      )
      SELECT rank, total_points as score
      FROM ranked
      WHERE id = $1`,
      [volunteerId]
    );

    if (result.rows.length === 0) {
      return { success: false, error: messages.volunteers.notFound };
    }

    return {
      success: true,
      data: result.rows[0],
    };
  } finally {
    client.release();
  }
};

export const getMyCreditRank = async (
  volunteerId: string
): Promise<ApiResponse<any>> => {
  const client = await pool.connect();

  try {
    const result = await client.query(
      `WITH ranked AS (
        SELECT id, credit_score,
               ROW_NUMBER() OVER (ORDER BY credit_score DESC, total_points DESC) as rank
        FROM volunteers
        WHERE is_active = true
      )
      SELECT rank, credit_score as score
      FROM ranked
      WHERE id = $1`,
      [volunteerId]
    );

    if (result.rows.length === 0) {
      return { success: false, error: messages.volunteers.notFound };
    }

    return {
      success: true,
      data: result.rows[0],
    };
  } finally {
    client.release();
  }
};

export const getTrendData = async (
  startDate: string,
  endDate: string
): Promise<ApiResponse<TrendData[]>> => {
  const client = await pool.connect();

  try {
    const result = await client.query(
      `WITH date_series AS (
        SELECT generate_series(
          $1::date,
          $2::date,
          '1 day'::interval
        ) as date
      )
      SELECT
        ds.date::text,
        COALESCE(SUM(sr.points_earned), 0) as total_points,
        COUNT(sr.id) FILTER (WHERE sr.is_no_show = false) as total_services,
        COALESCE(
          (SELECT AVG(v.credit_score) FROM volunteers v),
          0
        ) as average_credit
      FROM date_series ds
      LEFT JOIN service_records sr ON sr.recorded_at::date = ds.date
      GROUP BY ds.date
      ORDER BY ds.date`,
      [startDate, endDate]
    );

    return {
      success: true,
      data: result.rows,
    };
  } finally {
    client.release();
  }
};

export const getStatsOverview = async (): Promise<ApiResponse<any>> => {
  const client = await pool.connect();

  try {
    const volunteerStats = await client.query(
      `SELECT
        COUNT(*) as total_volunteers,
        COUNT(*) FILTER (WHERE is_active = true) as active_volunteers,
        COALESCE(AVG(total_points), 0) as avg_points,
        COALESCE(AVG(credit_score), 0) as avg_credit,
        COALESCE(AVG(level), 0) as avg_level
       FROM volunteers`
    );

    const serviceStats = await client.query(
      `SELECT
        COUNT(*) as total_services,
        COALESCE(SUM(duration_hours) FILTER (WHERE is_no_show = false), 0) as total_hours,
        COALESCE(AVG(rating) FILTER (WHERE rating > 0), 0) as avg_rating,
        COUNT(*) FILTER (WHERE is_no_show = true) as total_no_shows
       FROM service_records`
    );

    const complaintStats = await client.query(
      `SELECT
        COUNT(*) as total_complaints,
        COUNT(*) FILTER (WHERE status = 'pending') as pending_complaints,
        COUNT(*) FILTER (WHERE status = 'resolved') as resolved_complaints
       FROM complaints`
    );

    return {
      success: true,
      data: {
        volunteers: volunteerStats.rows[0],
        services: {
          ...serviceStats.rows[0],
          total_hours: parseFloat(serviceStats.rows[0].total_hours),
          avg_rating: parseFloat(serviceStats.rows[0].avg_rating),
        },
        complaints: complaintStats.rows[0],
      },
    };
  } finally {
    client.release();
  }
};
