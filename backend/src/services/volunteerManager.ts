import { Volunteer, ApiResponse, PaginatedData } from '../types';
import pool from '../db/pool';
import { messages } from '../constants/messages';

export const createVolunteer = async (
  name: string,
  phone?: string,
  email?: string
): Promise<ApiResponse<Volunteer>> => {
  const client = await pool.connect();

  try {
    const result = await client.query(
      `INSERT INTO volunteers (name, phone, email)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [name, phone, email]
    );

    return { success: true, data: result.rows[0] };
  } finally {
    client.release();
  }
};

export const getVolunteerById = async (
  volunteerId: string
): Promise<ApiResponse<Volunteer>> => {
  const client = await pool.connect();

  try {
    const result = await client.query(
      'SELECT * FROM volunteers WHERE id = $1',
      [volunteerId]
    );

    if (result.rows.length === 0) {
      return { success: false, error: messages.volunteers.notFound };
    }

    return { success: true, data: result.rows[0] };
  } finally {
    client.release();
  }
};

export const getVolunteers = async (
  page: number = 1,
  pageSize: number = 20,
  search?: string
): Promise<ApiResponse<PaginatedData<Volunteer>>> => {
  const client = await pool.connect();

  try {
    const offset = (page - 1) * pageSize;
    let query = 'SELECT * FROM volunteers';
    const params: any[] = [];

    if (search) {
      query += ' WHERE name ILIKE $1 OR phone ILIKE $1 OR email ILIKE $1';
      params.push(`%${search}%`);
    }

    query += ' ORDER BY total_points DESC';

    const countQuery = search
      ? 'SELECT COUNT(*) as total FROM volunteers WHERE name ILIKE $1 OR phone ILIKE $1 OR email ILIKE $1'
      : 'SELECT COUNT(*) as total FROM volunteers';

    const countResult = await client.query(countQuery, params);

    query += ' LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
    params.push(pageSize, offset);

    const result = await client.query(query, params);

    return {
      success: true,
      data: {
        data: result.rows,
        pagination: {
          page,
          page_size: pageSize,
          total: parseInt(countResult.rows[0].total),
          total_pages: Math.ceil(parseInt(countResult.rows[0].total) / pageSize),
        },
      },
    };
  } finally {
    client.release();
  }
};

export const updateVolunteer = async (
  volunteerId: string,
  updates: Partial<Pick<Volunteer, 'name' | 'phone' | 'email'>>
): Promise<ApiResponse<Volunteer>> => {
  const client = await pool.connect();

  try {
    const fields: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (updates.name !== undefined) {
      fields.push(`name = $${paramIndex++}`);
      values.push(updates.name);
    }
    if (updates.phone !== undefined) {
      fields.push(`phone = $${paramIndex++}`);
      values.push(updates.phone);
    }
    if (updates.email !== undefined) {
      fields.push(`email = $${paramIndex++}`);
      values.push(updates.email);
    }

    if (fields.length === 0) {
      return { success: false, error: messages.volunteers.noUpdatableFields };
    }

    values.push(volunteerId);

    const result = await client.query(
      `UPDATE volunteers SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return { success: false, error: messages.volunteers.notFound };
    }

    return { success: true, data: result.rows[0] };
  } finally {
    client.release();
  }
};

export const toggleVolunteerActive = async (
  volunteerId: string,
  isActive: boolean
): Promise<ApiResponse<Volunteer>> => {
  const client = await pool.connect();

  try {
    const result = await client.query(
      'UPDATE volunteers SET is_active = $1 WHERE id = $2 RETURNING *',
      [isActive, volunteerId]
    );

    if (result.rows.length === 0) {
      return { success: false, error: messages.volunteers.notFound };
    }

    return { success: true, data: result.rows[0] };
  } finally {
    client.release();
  }
};

export const getVolunteerPointsLogs = async (
  volunteerId: string,
  page: number = 1,
  pageSize: number = 20
): Promise<ApiResponse<any>> => {
  const client = await pool.connect();

  try {
    const offset = (page - 1) * pageSize;

    const countResult = await client.query(
      'SELECT COUNT(*) as total FROM points_logs WHERE volunteer_id = $1',
      [volunteerId]
    );

    const result = await client.query(
      `SELECT * FROM points_logs
       WHERE volunteer_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [volunteerId, pageSize, offset]
    );

    return {
      success: true,
      data: {
        logs: result.rows,
        pagination: {
          page,
          page_size: pageSize,
          total: parseInt(countResult.rows[0].total),
          total_pages: Math.ceil(parseInt(countResult.rows[0].total) / pageSize),
        },
      },
    };
  } finally {
    client.release();
  }
};

export const getVolunteerCreditLogs = async (
  volunteerId: string,
  page: number = 1,
  pageSize: number = 20
): Promise<ApiResponse<any>> => {
  const client = await pool.connect();

  try {
    const offset = (page - 1) * pageSize;

    const countResult = await client.query(
      'SELECT COUNT(*) as total FROM credit_logs WHERE volunteer_id = $1',
      [volunteerId]
    );

    const result = await client.query(
      `SELECT * FROM credit_logs
       WHERE volunteer_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [volunteerId, pageSize, offset]
    );

    return {
      success: true,
      data: {
        logs: result.rows,
        pagination: {
          page,
          page_size: pageSize,
          total: parseInt(countResult.rows[0].total),
          total_pages: Math.ceil(parseInt(countResult.rows[0].total) / pageSize),
        },
      },
    };
  } finally {
    client.release();
  }
};

export const getVolunteerSummary = async (
  volunteerId: string
): Promise<ApiResponse<any>> => {
  const client = await pool.connect();

  try {
    const volunteerResult = await client.query(
      'SELECT * FROM volunteers WHERE id = $1',
      [volunteerId]
    );

    if (volunteerResult.rows.length === 0) {
      return { success: false, error: messages.volunteers.notFound };
    }

    const volunteer = volunteerResult.rows[0];

    const badgesResult = await client.query(
      'SELECT * FROM badges WHERE volunteer_id = $1 ORDER BY star_level',
      [volunteerId]
    );

    const statsResult = await client.query(
      `SELECT
        COUNT(*) as total_services,
        COALESCE(SUM(CASE WHEN is_no_show = false THEN duration_hours ELSE 0 END), 0) as total_hours,
        COALESCE(AVG(CASE WHEN rating > 0 THEN rating END), 0) as avg_rating,
        COALESCE(SUM(CASE WHEN is_no_show = true THEN 1 ELSE 0 END), 0) as no_show_count
       FROM service_records WHERE volunteer_id = $1`,
      [volunteerId]
    );

    const complaintsResult = await client.query(
      'SELECT COUNT(*) as total_complaints, COUNT(*) FILTER (WHERE status = $1) as pending_complaints FROM complaints WHERE volunteer_id = $2',
      ['pending', volunteerId]
    );

    return {
      success: true,
      data: {
        volunteer,
        badges: badgesResult.rows,
        statistics: {
          ...statsResult.rows[0],
          total_hours: parseFloat(statsResult.rows[0].total_hours),
          avg_rating: parseFloat(statsResult.rows[0].avg_rating),
        },
        complaints: complaintsResult.rows[0],
      },
    };
  } finally {
    client.release();
  }
};
