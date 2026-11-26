const supabase = 'https://ururcsfneuyjrsvzpnxb.supabase.co';
const apiKey = 'sb_publishable_2fedo6dX3nz4Uh_lghtAmQ_dwBGH_3I';
const sessionKey = 'swim-coach-auth';
const coachLinkRequested = 'swim-coach-link-requested';
const app = document.querySelector('#app');
const roleLink = document.querySelector('#role-link');
const moscow = { timeZone: 'Europe/Moscow' };
const calendarDate = new Intl.DateTimeFormat('sv-SE', moscow);
const calendarTime = new Intl.DateTimeFormat('ru-RU', { ...moscow, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const longDate = new Intl.DateTimeFormat('ru-RU', { ...moscow, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const statuses = { planned: 'Запланирована', done: 'Проведена', cancelled: 'Отменена' };
const dateOf = value => calendarDate.format(new Date(value));
const timeOf = value => calendarTime.format(new Date(value));

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(text, handler, className) {
  const node = element('button', text, className);
  node.type = 'button';
  node.addEventListener('click', handler);
  return node;
}

function message() {
  const node = element('p', '', 'message');
  node.setAttribute('role', 'status');
  return node;
}

function showMessage(node, text, error = false) {
  node.textContent = text;
  node.classList.toggle('error', error);
}

async function action(control, notice, work) {
  control.disabled = true;
  showMessage(notice, '');
  try {
    await work();
  } catch (error) {
    showMessage(notice, error.message || 'Произошла ошибка. Попробуйте ещё раз.', true);
  } finally {
    control.disabled = false;
  }
}

async function request(path, payload, token) {
  const headers = { apikey: apiKey, 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  let response;
  try {
    response = await fetch(supabase + path, {
      method: 'POST', headers, body: JSON.stringify(payload), cache: 'no-store'
    });
  } catch {
    throw new Error('Не удалось связаться с сервером. Проверьте интернет и попробуйте ещё раз.');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const setupPending = data?.code === 'PGRST202';
    const detail = data?.message || data?.msg || data?.error_description;
    const error = new Error(setupPending ? 'Кабинет ещё не подключён. Уточните у тренера.' : detail || 'Сервер временно недоступен.');
    error.status = response.status;
    throw error;
  }
  return data;
}

async function rpc(name, payload = {}, coach = false) {
  const token = coach ? await coachToken() : undefined;
  return request('/rest/v1/rpc/' + name, payload, token);
}

function heading(title, description, control) {
  const wrapper = element('div', '', 'page-heading');
  const content = element('div');
  content.append(element('h1', title), element('p', description, 'muted'));
  wrapper.append(content);
  if (control) wrapper.append(control);
  return wrapper;
}

function appendTabs(container, tabs, selected, onSelect) {
  const group = element('div', '', 'tabs');
  for (const [id, title] of tabs) {
    const item = button(title, () => onSelect(id));
    item.setAttribute('aria-pressed', String(selected === id));
    group.append(item);
  }
  container.append(group);
}

function lessonList(lessons, names, onEdit, emptyText = 'Тренировок пока нет.') {
  if (!lessons.length) return element('p', emptyText, 'muted');
  const list = element('ul', '', 'list');
  for (const lesson of lessons) {
    const entry = element('li');
    const detail = element('div');
    if (names) detail.append(element('h3', names.get(lesson.student_id)));
    const time = element('time', longDate.format(new Date(lesson.starts_at)));
    time.dateTime = lesson.starts_at;
    detail.append(time, element('small', timeOf(lesson.starts_at) + '–' + timeOf(lesson.ends_at)));
    if (lesson.from_calendar) detail.append(element('small', 'Из календаря iPhone'));
    const controls = element('div', '', 'actions');
    const status = lesson.status === 'planned' && new Date(lesson.ends_at) <= new Date()
      ? 'Ожидает отметки тренера' : statuses[lesson.status];
    controls.append(element('span', status, 'badge ' + lesson.status));
    if (onEdit) controls.append(button('Открыть', () => onEdit(lesson)));
    entry.append(detail, controls);
    list.append(entry);
  }
  return list;
}

let studentCredentials;
let studentData;
let studentTab = 'today';

function renderStudent() {
  const activePanel = document.activeElement?.closest('.tabs') ? studentTab : null;
  const today = dateOf(new Date());
  const groups = {
    today: studentData.lessons.filter(lesson => dateOf(lesson.starts_at) <= today && lesson.status === 'planned'),
    future: studentData.lessons.filter(lesson => dateOf(lesson.starts_at) > today && lesson.status === 'planned'),
    done: studentData.lessons.filter(lesson => lesson.status === 'done').slice().reverse(),
    cancelled: studentData.lessons.filter(lesson => lesson.status === 'cancelled').slice().reverse()
  };
  const panel = element('section', '', 'card');
  appendTabs(panel, [['today', 'Текущие'], ['future', 'Будущие'], ['done', 'Проведённые'], ['cancelled', 'Отменённые']], studentTab, tab => {
    studentTab = tab;
    renderStudent();
  });
  const notices = message();
  const update = button('Обновить', () => action(update, notices, async () => {
    const data = await rpc('swim_student_schedule', studentCredentials);
    if (!data) {
      location.replace('./');
      return;
    }
    studentData = data;
    renderStudent();
  }));
  const controls = element('div', '', 'actions');
  controls.append(update, button('Выйти', () => location.replace('./')));
  panel.append(lessonList(groups[studentTab]), notices);
  app.replaceChildren(heading('Мои тренировки', studentData.name + ' · московское время', controls), panel);
  if (activePanel) panel.querySelector('[aria-pressed=true]').focus();
}

function bindStudent() {
  const form = document.querySelector('#student-login');
  form.addEventListener('submit', event => {
    event.preventDefault();
    const values = new FormData(form);
    action(form.querySelector('button'), form.querySelector('.message'), async () => {
      const credentials = {
        student_phone: values.get('phone').trim(),
        access_code: values.get('code').trim().toLowerCase()
      };
      const data = await rpc('swim_student_schedule', credentials);
      if (!data) throw new Error('Проверьте номер телефона и персональный код.');
      studentCredentials = credentials;
      studentData = data;
      if (!data.lessons.some(lesson => dateOf(lesson.starts_at) <= dateOf(new Date()) && lesson.status === 'planned')) studentTab = 'future';
      renderStudent();
    });
  });
}

function saveSession(data) {
  const expires = Number(data.expires_at || (Date.now() / 1000 + Number(data.expires_in || 3600)));
  sessionStorage.setItem(sessionKey, JSON.stringify({
    access_token: data.access_token, refresh_token: data.refresh_token, expires_at: expires
  }));
}

let refresh;
async function coachToken() {
  const session = JSON.parse(sessionStorage.getItem(sessionKey) || 'null');
  if (!session) throw new Error('Войдите по электронной почте.');
  if (session.expires_at > Date.now() / 1000 + 60) return session.access_token;
  if (!refresh) {
    refresh = request('/auth/v1/token?grant_type=refresh_token', { refresh_token: session.refresh_token })
      .then(data => {
        saveSession(data);
        return data.access_token;
      }).finally(() => { refresh = null; });
  }
  return refresh;
}

function field(form, label, name, type = 'text', value = '', options = {}) {
  const wrapper = element('label', label);
  const input = document.createElement(type === 'select' ? 'select' : 'input');
  if (type !== 'select') input.type = type;
  input.name = name;
  Object.assign(input, options);
  input.value = value;
  wrapper.append(input);
  form.append(wrapper);
  return input;
}

function option(select, value, text) {
  const node = element('option', text);
  node.value = value;
  select.append(node);
}

function coachLogin(initialError = '') {
  const card = element('section', '', 'card narrow stacked');
  const form = element('form');
  const notices = message();
  field(form, 'Электронная почта', 'email', 'email', '', { required: true, autocomplete: 'email' });
  const submit = element('button', 'Отправить ссылку для входа', 'primary');
  form.append(submit, notices);
  form.addEventListener('submit', event => {
    event.preventDefault();
    const email = new FormData(form).get('email').trim();
    action(submit, notices, async () => {
      const redirect = new URL('?coach', location.href);
      localStorage.setItem(coachLinkRequested, String(Date.now()));
      try {
        await request('/auth/v1/otp?redirect_to=' + encodeURIComponent(redirect.href), { email, create_user: false });
      } catch (error) {
        localStorage.removeItem(coachLinkRequested);
        throw error;
      }
      showMessage(notices, 'Откройте ссылку из письма в этом же браузере.');
    });
  });
  const archive = element('a', 'Открыть дневник репетитора');
  archive.href = './diary.html';
  if (initialError) showMessage(notices, initialError, true);
  card.append(element('h1', 'Кабинет тренера'), form, archive);
  app.replaceChildren(card);
}

let coachData;
let coachSection = 'schedule';
let selectedDay = dateOf(new Date());

async function loadCoach() {
  coachData = await rpc('swim_coach_data', {}, true);
  renderCoach();
}

function renderCoach() {
  const card = element('section', '', 'card');
  appendTabs(card, [['schedule', 'Расписание'], ['students', 'Ученики'], ['calendar', 'Календарь iPhone']], coachSection, section => {
    coachSection = section;
    renderCoach();
    app.querySelector('[aria-pressed=true]')?.focus();
  });
  if (coachSection === 'students') renderStudents(card);
  else if (coachSection === 'calendar') renderCalendar(card);
  else renderCoachSchedule(card);
  const notice = message();
  const controls = element('div', '', 'actions');
  const update = button('Обновить', () => action(update, notice, loadCoach));
  controls.append(update, button('Выйти', () => {
    sessionStorage.removeItem(sessionKey);
    location.replace('?coach');
  }));
  app.replaceChildren(heading('Кабинет тренера', 'Расписание и доступ учеников', controls), notice, card);
}

function modal(title, save) {
  const dialog = element('dialog');
  const form = element('form');
  const controls = element('div', '', 'actions');
  const submit = element('button', 'Сохранить', 'primary');
  const notices = message();
  controls.append(submit, button('Закрыть', () => dialog.close()));
  dialog.append(element('h2', title), form);
  dialog.addEventListener('close', () => dialog.remove());
  form.addEventListener('submit', event => {
    event.preventDefault();
    const payload = new FormData(form);
    action(submit, notices, async () => {
      await save(payload);
      dialog.close();
      const feedback = app.querySelector(':scope > .message');
      await action(submit, feedback, loadCoach);
    });
  });
  return {
    form,
    open() {
      form.append(controls, notices);
      document.body.append(dialog);
      dialog.showModal();
    }
  };
}

function editLesson(lesson) {
  const view = modal(lesson ? 'Тренировка' : 'Новая тренировка', form => {
    const starts = form.get('starts_at') || localDateTime(lesson.starts_at);
    const ends = form.get('ends_at') || localDateTime(lesson.ends_at);
    return rpc('swim_save_lesson', {
      lesson: lesson?.id ?? null, student: form.get('student') || lesson?.student_id,
      starts: starts + ':00+03:00', ends: ends + ':00+03:00', new_status: form.get('status')
    }, true);
  });
  const students = field(view.form, 'Ученик', 'student', 'select', '', { required: true });
  for (const student of coachData.students) option(students, student.id, student.name);
  if (lesson) students.value = lesson.student_id;
  const start = field(view.form, 'Начало (МСК)', 'starts_at', 'datetime-local', lesson ? localDateTime(lesson.starts_at) : selectedDay + 'T17:00', { required: true });
  const end = field(view.form, 'Окончание (МСК)', 'ends_at', 'datetime-local', lesson ? localDateTime(lesson.ends_at) : selectedDay + 'T18:00', { required: true });
  if (lesson?.from_calendar) {
    students.disabled = start.disabled = end.disabled = true;
    view.form.append(element('p', 'Время этой тренировки меняется в календаре iPhone.', 'muted'));
  } else {
    start.addEventListener('change', () => {
      if (!start.value || end.value > start.value) return;
      const next = new Date(Date.parse(start.value + ':00+03:00') + 3600000);
      end.value = localDateTime(next);
    });
  }
  const status = field(view.form, 'Статус', 'status', 'select', '', { required: true });
  for (const [id, label] of Object.entries(statuses)) option(status, id, label);
  status.value = lesson?.status || 'planned';
  view.open();
}

const localDateTime = value => dateOf(value) + 'T' + timeOf(value);

function renderCoachSchedule(panel) {
  const header = element('div', '', 'section-heading');
  const label = element('label', 'День тренировок (МСК)');
  const date = element('input');
  date.type = 'date';
  date.value = selectedDay;
  const list = element('div');
  function refreshDay() {
    const lessons = coachData.lessons.filter(lesson => dateOf(lesson.starts_at) === selectedDay);
    list.replaceChildren(lessonList(lessons, new Map(coachData.students.map(student => [student.id, student.name])), editLesson, 'На этот день тренировок нет.'));
  }
  date.addEventListener('change', () => {
    if (!date.value) return;
    selectedDay = date.value;
    refreshDay();
  });
  label.append(date);
  const add = button('Добавить тренировку', () => editLesson(), 'primary');
  add.disabled = coachData.students.length === 0;
  header.append(label, add);
  panel.append(header, list);
  if (!coachData.students.length) panel.append(element('p', 'Добавьте ученика или подключите календарь iPhone.', 'muted'));
  refreshDay();
}

function editStudent(student) {
  const view = modal(student ? 'Карточка ученика' : 'Новый ученик', form => rpc('swim_save_student', {
    student: student?.id ?? null, student_name: form.get('name'), student_phone: form.get('phone')
  }, true));
  field(view.form, 'Имя', 'name', 'text', student?.name, { required: true, maxLength: 100 });
  field(view.form, 'Телефон', 'phone', 'tel', student?.phone, { required: true, maxLength: 40 });
  if (student?.has_access) view.form.append(element('p', 'При изменении номера ученику потребуется новый код.', 'muted'));
  view.open();
}

function revealCredential(parent, label, value) {
  const box = element('div', '', 'credentials');
  box.append(element('strong', label), element('code', value));
  const notices = message();
  const copy = button('Скопировать', () => action(copy, notices, async () => {
    await navigator.clipboard.writeText(value);
    showMessage(notices, 'Скопировано.');
  }));
  box.append(copy, notices);
  parent.replaceChildren(box);
}

function renderStudents(panel) {
  const header = element('div', '', 'section-heading');
  header.append(element('h2', 'Ученики'), button('Добавить ученика', () => editStudent(), 'primary'));
  panel.append(header);
  if (!coachData.students.length) {
    panel.append(element('p', 'Ученики появятся здесь после добавления или импорта из календаря.', 'muted'));
    return;
  }
  const list = element('ul', '', 'list');
  for (const student of coachData.students) {
    const row = element('li');
    row.style.display = 'block';
    const top = element('div', '', 'section-heading');
    const person = element('div');
    person.append(element('h3', student.name), element('small', student.phone));
    const controls = element('div', '', 'actions');
    const result = element('div');
    const notices = message();
    const create = button(student.has_access ? 'Обновить код' : 'Выдать код', () => {
      if (student.has_access && !confirm('Заменить действующий код ученика?')) return;
      action(create, notices, async () => {
        const code = await rpc('swim_student_access', { student: student.id, enable_access: true }, true);
        student.has_access = true;
        create.textContent = 'Обновить код';
        revoke.hidden = false;
        revealCredential(result, 'Персональный код ученика', code);
      });
    });
    const revoke = button('Отключить доступ', () => {
      if (!confirm('Отключить доступ ученика к расписанию?')) return;
      action(revoke, notices, async () => {
        await rpc('swim_student_access', { student: student.id, enable_access: false }, true);
        student.has_access = false;
        create.textContent = 'Выдать код';
        revoke.hidden = true;
        result.replaceChildren();
        showMessage(notices, 'Доступ отключён.');
      });
    });
    revoke.hidden = !student.has_access;
    controls.append(button('Карточка', () => editStudent(student)), create, revoke);
    top.append(person, controls);
    row.append(top, result, notices);
    list.append(row);
  }
  panel.append(list);
}

function renderCalendar(panel) {
  const setup = element('a', 'Инструкция для приложения «Команды»');
  setup.href = 'https://github.com/Maks2004A/dnevnik/blob/main/swim/iphone.md';
  setup.target = '_blank';
  setup.rel = 'noopener noreferrer';
  const summary = coachData.last_snapshot
    ? 'Последний импорт: ' + longDate.format(new Date(coachData.last_snapshot)) + ', ' + timeOf(coachData.last_snapshot) + ' МСК.'
    : 'Импорт ещё не выполнялся.';
  const body = element('div', '', 'stacked');
  const result = element('div');
  const notices = message();
  const controls = element('div', '', 'actions');
  const issue = button('Создать ключ календаря', () => {
    if (!confirm('Создать новый ключ календаря? Предыдущий ключ перестанет работать.')) return;
    action(issue, notices, async () => {
      const data = await rpc('swim_calendar_key', { enable_calendar: true }, true);
      revealCredential(result, 'Ключ для команды на iPhone', data.key);
    });
  }, 'primary');
  const revoke = button('Отключить импорт', () => {
    if (!confirm('Отключить подключённую команду iPhone?')) return;
    action(revoke, notices, async () => {
      await rpc('swim_calendar_key', { enable_calendar: false }, true);
      result.replaceChildren();
      showMessage(notices, 'Импорт отключён.');
    });
  });
  controls.append(issue, revoke);
  body.append(element('h2', 'Синхронизация с iPhone'), element('p', summary, 'muted'),
    element('p', 'В отдельном календаре указывайте имя ученика в названии события, а телефон в поле «Заметки».'),
    setup, controls, result, notices);
  panel.append(body);
}

const callback = new URLSearchParams(location.hash.slice(1));
const hasTokens = callback.has('access_token') && callback.has('refresh_token');
const wantsCoach = new URLSearchParams(location.search).has('coach');
const pendingCoachLink = Date.now() - Number(localStorage.getItem(coachLinkRequested)) < 3600000;
if (hasTokens && !wantsCoach && !pendingCoachLink) {
  location.replace('./diary.html' + location.hash);
} else if (wantsCoach || (pendingCoachLink && (hasTokens || callback.has('error_description')))) {
  roleLink.href = './';
  roleLink.textContent = 'Вход ученика';
  if (hasTokens) {
    localStorage.removeItem(coachLinkRequested);
    saveSession(Object.fromEntries(callback));
    history.replaceState(null, '', '?coach');
  }
  if (callback.has('error_description')) {
    localStorage.removeItem(coachLinkRequested);
    history.replaceState(null, '', '?coach');
    coachLogin('Ссылка для входа недействительна. Запросите новую.');
  } else if (sessionStorage.getItem(sessionKey)) {
    app.replaceChildren(element('p', 'Загружаем расписание…', 'muted'));
    loadCoach().catch(error => coachLogin(error.message));
  } else {
    coachLogin();
  }
} else {
  bindStudent();
}
