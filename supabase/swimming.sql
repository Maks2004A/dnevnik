begin;

create schema if not exists swimming;
revoke all on schema swimming from public, anon, authenticated;

create table if not exists swimming.coaches (
  user_id uuid primary key references auth.users(id) on delete cascade,
  calendar_hash text unique,
  last_snapshot timestamptz
);
create table if not exists swimming.students (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references swimming.coaches(user_id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 100),
  phone text not null check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  access_hash text,
  unique (coach_id, phone),
  unique (coach_id, id)
);
create table if not exists swimming.lessons (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null,
  student_id uuid not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'planned' check (status in ('planned','done','cancelled')),
  calendar_start timestamptz,
  absent_from_calendar boolean not null default false,
  foreign key (coach_id, student_id) references swimming.students(coach_id, id),
  unique (coach_id, student_id, calendar_start),
  check (ends_at > starts_at and ends_at <= starts_at + interval '8 hours')
);
create index if not exists swimming_lesson_times on swimming.lessons(coach_id, starts_at);
create index if not exists swimming_student_lesson_times on swimming.lessons(student_id, starts_at);
create index if not exists swimming_student_access_lookup on swimming.students(phone, access_hash) where access_hash is not null;
revoke all on all tables in schema swimming from public, anon, authenticated;
alter table swimming.coaches enable row level security;
alter table swimming.students enable row level security;
alter table swimming.lessons enable row level security;

create or replace function swimming.require_coach()
returns uuid language plpgsql security invoker set search_path = '' as $$
declare coach uuid := auth.uid();
begin
  if coach is null or not exists(select 1 from swimming.coaches where user_id = coach) then
    raise exception 'Нет доступа к кабинету тренера' using errcode = '42501';
  end if;
  return coach;
end;
$$;

create or replace function swimming.normal_phone(raw text)
returns text language plpgsql immutable set search_path = '' as $$
declare digits text := regexp_replace(btrim(raw), '[^0-9]', '', 'g');
begin
  if raw is null or char_length(raw) > 40 or btrim(raw) !~ '^\+?[0-9 ()-]+$' then
    return null;
  end if;
  if left(btrim(raw), 1) <> '+' then
    if digits ~ '^[78][0-9]{10}$' then
      digits := '7' || substr(digits, 2);
    elsif digits ~ '^[0-9]{10}$' then
      digits := '7' || digits;
    else
      return null;
    end if;
  end if;
  return case when digits ~ '^[1-9][0-9]{7,14}$' then '+' || digits end;
end;
$$;

create or replace function swimming.secret_hash(secret text)
returns text language sql immutable strict set search_path = '' as $$
  select encode(sha256(convert_to(secret, 'UTF8')), 'hex')
$$;

create or replace function public.swim_coach_data()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare coach uuid := swimming.require_coach();
begin
  return jsonb_build_object(
    'students', coalesce((select jsonb_agg(jsonb_build_object(
      'id', id, 'name', name, 'phone', phone, 'has_access', access_hash is not null
    ) order by name) from swimming.students where coach_id = coach), '[]'),
    'lessons', coalesce((select jsonb_agg(jsonb_build_object(
      'id', id, 'student_id', student_id, 'starts_at', starts_at, 'ends_at', ends_at,
      'status', status, 'from_calendar', calendar_start is not null
    ) order by starts_at) from swimming.lessons where coach_id = coach), '[]'),
    'last_snapshot', (select last_snapshot from swimming.coaches where user_id = coach)
  );
end;
$$;

create or replace function public.swim_save_student(student uuid, student_name text, student_phone text)
returns void language plpgsql security definer set search_path = '' as $$
declare coach uuid := swimming.require_coach();
declare phone_value text := swimming.normal_phone(student_phone);
begin
  if phone_value is null then raise exception 'Введите номер телефона в международном формате, например +7'; end if;
  perform 1 from swimming.coaches where user_id = coach for update;
  if student is null then
    insert into swimming.students(coach_id, name, phone) values (coach, btrim(student_name), phone_value);
  else
    update swimming.students set name = btrim(student_name), phone = phone_value,
      access_hash = case when phone = phone_value then access_hash end
      where id = student and coach_id = coach;
    if not found then raise exception 'Ученик не найден'; end if;
  end if;
exception when unique_violation then raise exception 'Этот номер уже указан у другого ученика';
end;
$$;

create or replace function public.swim_student_access(student uuid, enable_access boolean)
returns text language plpgsql security definer set search_path = '' as $$
declare coach uuid := swimming.require_coach();
declare secret text := case when enable_access then replace(gen_random_uuid()::text, '-', '') end;
begin
  update swimming.students set access_hash = swimming.secret_hash(secret)
    where id = student and coach_id = coach;
  if not found then raise exception 'Ученик не найден'; end if;
  return secret;
end;
$$;

create or replace function public.swim_student_schedule(student_phone text, access_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare student swimming.students%rowtype;
begin
  if access_code is null or access_code !~ '^[0-9a-f]{32}$' then return null; end if;
  select * into student from swimming.students
    where phone = swimming.normal_phone(student_phone) and access_hash = swimming.secret_hash(access_code);
  if not found then return null; end if;
  return jsonb_build_object('name', student.name, 'lessons', coalesce((
    select jsonb_agg(jsonb_build_object('starts_at', starts_at, 'ends_at', ends_at, 'status', status)
      order by starts_at) from swimming.lessons where coach_id = student.coach_id and student_id = student.id
    ), '[]'));
end;
$$;

create or replace function public.swim_save_lesson(
  lesson uuid, student uuid, starts timestamptz, ends timestamptz, new_status text
)
returns void language plpgsql security definer set search_path = '' as $$
declare coach uuid := swimming.require_coach();
begin
  perform 1 from swimming.coaches where user_id = coach for update;
  if new_status = 'done' and coalesce((
    select starts_at from swimming.lessons
    where id = lesson and coach_id = coach and calendar_start is not null
  ), starts) > now() then
    raise exception 'Тренировка ещё не началась';
  end if;
  if lesson is null then
    insert into swimming.lessons(coach_id, student_id, starts_at, ends_at, status)
      values (coach, student, starts, ends, new_status);
  else
    update swimming.lessons set status = new_status, absent_from_calendar = false,
      student_id = case when calendar_start is null then student else student_id end,
      starts_at = case when calendar_start is null then starts else starts_at end,
      ends_at = case when calendar_start is null then ends else ends_at end
      where id = lesson and coach_id = coach;
    if not found then raise exception 'Тренировка не найдена'; end if;
  end if;
end;
$$;

create or replace function public.swim_calendar_key(enable_calendar boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare coach uuid := swimming.require_coach();
declare secret text := case when enable_calendar then replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '') end;
begin
  update swimming.coaches set calendar_hash = swimming.secret_hash(secret) where user_id = coach;
  return jsonb_build_object('key', secret);
end;
$$;

-- The shortcut sends a complete snapshot of the selected calendar for the stated window.
-- A row uses: ISO start | ISO end | name | phone. Calendars and contact notes stay on the device.
create or replace function public.swim_calendar_import(
  calendar_key text, captured_at timestamptz, window_from timestamptz, window_until timestamptz, events text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare coach swimming.coaches%rowtype;
declare parts text[];
declare row_text text;
declare starts timestamptz;
declare ends timestamptz;
declare student_phone text;
declare student_name text;
declare student swimming.students%rowtype;
declare imported uuid;
declare seen uuid[] := '{}';
declare row_number integer := 0;
declare cancelled_count integer;
begin
  if calendar_key is null or calendar_key !~ '^[0-9a-f]{64}$' then
    raise exception 'Неверный ключ календаря' using errcode = '42501';
  end if;
  select * into coach from swimming.coaches
    where calendar_hash = swimming.secret_hash(calendar_key) for update;
  if not found then raise exception 'Неверный ключ календаря' using errcode = '42501'; end if;
  if captured_at is null or window_from is null or window_until is null or events is null
    or captured_at < now() - interval '1 day' or captured_at > now() + interval '5 minutes'
    or window_until <= window_from or window_until - window_from > interval '93 days'
    or window_from < captured_at - interval '93 days' or window_until > captured_at + interval '93 days'
    or octet_length(events) > 200000 then
    raise exception 'Некорректный диапазон или размер календаря';
  end if;
  if coach.last_snapshot >= captured_at then
    return jsonb_build_object('ignored', true);
  end if;

  foreach row_text in array regexp_split_to_array(events, E'\\r?\\n') loop
    if btrim(row_text) = '' then continue; end if;
    row_number := row_number + 1;
    parts := string_to_array(row_text, '|');
    if cardinality(parts) <> 4 or row_number > 1000 then
      raise exception 'Строка %: ожидаются четыре поля, максимум 1000 тренировок', row_number;
    end if;
    if btrim(parts[1]) !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$'
      or btrim(parts[2]) !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$' then
      raise exception 'Строка %: используйте даты ISO 8601 с часовым поясом', row_number;
    end if;
    starts := date_trunc('minute', btrim(parts[1])::timestamptz);
    ends := date_trunc('minute', btrim(parts[2])::timestamptz);
    student_name := regexp_replace(btrim(parts[3]), '[[:space:]]+', ' ', 'g');
    student_phone := swimming.normal_phone(parts[4]);
    if starts < window_from or starts >= window_until or ends <= starts or ends > starts + interval '8 hours'
      or char_length(student_name) not between 1 and 100 or student_phone is null then
      raise exception 'Строка %: проверьте дату, длительность, имя и телефон', row_number;
    end if;

    select * into student from swimming.students where coach_id = coach.user_id and phone = student_phone;
    if not found then
      insert into swimming.students(coach_id, name, phone) values (coach.user_id, student_name, student_phone)
        returning * into student;
    elsif lower(regexp_replace(student.name, '[[:space:]]+', ' ', 'g')) <> lower(student_name) then
      raise exception 'Строка %: имя в календаре и в карточке с этим телефоном различается', row_number;
    end if;

    select id into imported from swimming.lessons
      where coach_id = coach.user_id and student_id = student.id and calendar_start = starts;
    if found then
      update swimming.lessons set
        ends_at = case when status = 'done' then ends_at else ends end,
        status = case when absent_from_calendar then 'planned' else status end,
        absent_from_calendar = false
        where id = imported;
    else
      -- Reuse an existing manual entry at the same time instead of publishing it twice.
      select id into imported from swimming.lessons
        where coach_id = coach.user_id and student_id = student.id and starts_at = starts
          and calendar_start is null order by (status <> 'cancelled') desc, id limit 1;
      if found then
        update swimming.lessons set calendar_start = starts,
          ends_at = case when status = 'done' then ends_at else ends end where id = imported;
      else
        insert into swimming.lessons(coach_id, student_id, starts_at, ends_at, calendar_start)
          values (coach.user_id, student.id, starts, ends, starts) returning id into imported;
      end if;
    end if;
    if imported = any(seen) then raise exception 'Строка %: повтор тренировки', row_number; end if;
    seen := array_append(seen, imported);
  end loop;

  -- Only future plans within the imported window can disappear from the calendar.
  -- Preserve the association and restore only automatic cancellations if the event returns.
  update swimming.lessons set status = 'cancelled', absent_from_calendar = true
    where coach_id = coach.user_id and calendar_start >= greatest(window_from, now())
      and calendar_start < window_until and status = 'planned' and not (id = any(seen));
  get diagnostics cancelled_count = row_count;
  update swimming.coaches set last_snapshot = captured_at where user_id = coach.user_id;
  return jsonb_build_object('imported', row_number, 'cancelled', cancelled_count);
end;
$$;

revoke execute on all functions in schema swimming from public, anon, authenticated;
revoke execute on function
  public.swim_coach_data(), public.swim_save_student(uuid, text, text),
  public.swim_student_access(uuid, boolean), public.swim_student_schedule(text, text),
  public.swim_save_lesson(uuid, uuid, timestamptz, timestamptz, text), public.swim_calendar_key(boolean),
  public.swim_calendar_import(text, timestamptz, timestamptz, timestamptz, text)
  from public, anon, authenticated;

grant execute on function
  public.swim_coach_data(), public.swim_save_student(uuid, text, text),
  public.swim_student_access(uuid, boolean), public.swim_save_lesson(uuid, uuid, timestamptz, timestamptz, text),
  public.swim_calendar_key(boolean) to authenticated;
grant execute on function
  public.swim_student_schedule(text, text), public.swim_calendar_import(text, timestamptz, timestamptz, timestamptz, text)
  to anon, authenticated;

notify pgrst, 'reload schema';
commit;
