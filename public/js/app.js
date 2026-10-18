/* Smart Fire Guard · vanilla JS dashboard. Existing backend contracts are preserved. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const clock = value => new Intl.DateTimeFormat('vi-VN', {hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date(value));
  const storage = {
    get(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, value); return true; } catch { return false; } }
  };
  const metrics = [
    {key:'temperature',threshold:'temp',label:'Nhiệt độ',unit:'°C',icon:'♨',color:'var(--temp)',range:[-40,125]},
    {key:'gas',threshold:'gas',label:'Khí gas',unit:'%',icon:'◇',color:'var(--gas)',range:[0,100]},
    {key:'smoke',threshold:'smoke',label:'Khói',unit:'%',icon:'≋',color:'var(--smoke)',range:[0,100]}
  ];
  const pages = {
    overview:['Tổng quan hệ thống','Theo dõi môi trường. Nhận biết rủi ro. Chủ động phản ứng.','Tổng quan'],
    sensors:['Giám sát cảm biến','Theo dõi xu hướng và chất lượng dữ liệu nhận được.','Cảm biến'],
    devices:['Quản lý thiết bị','Thông tin kết nối và cấu hình hiển thị của ESP32.','Thiết bị'],
    camera:['Camera & nhận diện AI','Kiểm soát webcam và theo dõi kết quả thử nghiệm.','Camera & AI'],
    alerts:['Trung tâm cảnh báo','Nhận biết mức độ nguy hiểm và kiểm thử cảnh báo.','Cảnh báo'],
    history:['Nhật ký hệ thống','Tra cứu sự kiện và dữ liệu nhận trong phiên giám sát.','Nhật ký'],
    settings:['Cài đặt giám sát','Ngưỡng máy chủ và tùy chọn của không gian làm việc.','Cài đặt']
  };
  const levels = {ok:['Bình thường','good'],warn:['Cảnh báo','warning'],bad:['Nguy hiểm','danger'],unknown:['Chưa xác định','neutral']};
  let state = null, thresholds = null, samples = [], logs = [];
  let serverOnline = false, lastReceived = 0, logsBusy = false, logError = '', logLoaded = false;
  let deviceName = storage.get('fg-device-name','ESP32 trung tâm'), deviceLocation = storage.get('fg-device-location','');
  let theme = storage.get('fg-theme','system'), soundEnabled = storage.get('fg-sound','true') === 'true';
  let socket, audioCtx, oscillator, gain, stream = null, frameTimer = null, cameraEpoch = 0, cameraPending = false;
  let toastTimer, statusRequest = 0, stateRevision = 0, lastLogFetch = 0, previewReady = false, range = 60;
  let telemetryStale = false;

  function badge(label, tone='neutral') { return `<span class="badge ${tone}">${escape(label)}</span>`; }
  function setBadge(id,label,tone) { const el=$(id); el.textContent=label; el.className=`badge ${tone}`; }
  function toast(message) {
    $('toast').textContent=message; $('toast').hidden=false;
    clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('toast').hidden=true,5000);
  }
  // The legacy server may keep a hardware source label after falling back to simulation.
  function isDemo(s=state) { return !!s && (s.source === 'SIMULATION' || s.esp32Connected !== true); }
  function sourceText(s=state) {
    return !s ? 'Chưa có nguồn' : isDemo(s) ? 'DEMO · Giả lập' : s.source === 'ESP32_HARDWARE' ? 'ESP32 · Telemetry' : 'Nguồn chưa xác minh';
  }
  function valid(metric,s=state) { const v=s?.[metric.key]; return finite(v) && v>=metric.range[0] && v<=metric.range[1]; }
  function fresh() {
    const ping=Date.parse(state?.lastEsp32Ping);
    const hardwareFresh=state?.esp32Connected!==true || (Number.isFinite(ping)&&Date.now()-ping<12000);
    return serverOnline && lastReceived>0 && Date.now()-lastReceived<12000 && !telemetryStale && hardwareFresh;
  }
  function deviceOnline() {
    const ping=Date.parse(state?.lastEsp32Ping);
    return serverOnline && state?.esp32Connected===true && Number.isFinite(ping) && Date.now()-ping<12000;
  }
  function levelFor(metric,s=state,limits=thresholds) {
    if(!valid(metric,s)||!limits?.[metric.threshold]) return 'unknown';
    const v=s[metric.key],t=limits[metric.threshold];
    return v>t.danger?'bad':v>t.warn?'warn':'ok';
  }
  function overall() {
    if(!state || !fresh()) return 'unknown';
    if(state.level==='bad') return 'bad';
    if(metrics.some(m=>!valid(m)) || typeof state.flame!=='boolean') return 'unknown';
    return Object.hasOwn(levels,state.level)?state.level:'unknown';
  }
  function metricValue(m,s=state) { return valid(m,s)?`${s[m.key].toFixed(m.key==='temperature'?1:0)}<small>${m.unit}</small>`:'—'; }

  function applyTheme(value) {
    theme=['system','light','dark'].includes(value)?value:'system';
    const dark=theme==='dark'||theme==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme=dark?'dark':'light'; $('theme-select').value=theme;
    $('theme-toggle').setAttribute('aria-label',dark?'Chuyển sang giao diện sáng':'Chuyển sang giao diện tối');
  }
  applyTheme(theme);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>applyTheme(theme));
  $('theme-select').onchange=e=>{applyTheme(e.target.value);if(!storage.set('fg-theme',theme))toast('Không thể lưu tùy chọn trên trình duyệt.');};
  $('theme-toggle').onclick=()=>{applyTheme(document.documentElement.dataset.theme==='dark'?'light':'dark');storage.set('fg-theme',theme);};
  $('today').textContent=new Intl.DateTimeFormat('vi-VN',{day:'2-digit',month:'long',year:'numeric'}).format(new Date());

  const mobileNavigation=window.matchMedia('(max-width: 760px)');
  function toggleMenu(open) {
    $('sidebar').classList.toggle('open',open); $('backdrop').hidden=!open;
    $('sidebar').inert=mobileNavigation.matches&&!open;
    $('menu-toggle').setAttribute('aria-expanded',String(open));
    if(open) $('nav').querySelector('a').focus(); else $('menu-toggle').focus({preventScroll:true});
  }
  $('sidebar').inert=mobileNavigation.matches;
  mobileNavigation.addEventListener('change',()=>{
    $('sidebar').classList.toggle('open',false); $('backdrop').hidden=true;
    $('sidebar').inert=mobileNavigation.matches;
    $('menu-toggle').setAttribute('aria-expanded','false');
  });
  $('menu-toggle').onclick=()=>toggleMenu(!$('sidebar').classList.contains('open'));
  $('backdrop').onclick=()=>toggleMenu(false);
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'&&$('sidebar').classList.contains('open')) toggleMenu(false);
    if(e.key==='Tab'&&$('sidebar').classList.contains('open')) {
      const links=$('sidebar').querySelectorAll('a');
      if(e.shiftKey&&document.activeElement===links[0]) {e.preventDefault();links[links.length-1].focus();}
      else if(!e.shiftKey&&document.activeElement===links[links.length-1]) {e.preventDefault();links[0].focus();}
    }
  });
  function route() {
    const aliases={dash:'overview',sens:'sensors',cam:'camera',hist:'history',iot:'devices'};
    const hash=location.hash.slice(1), page=pages[hash]?hash:aliases[hash]||'overview';
    document.querySelectorAll('.view').forEach(el=>el.hidden=el.id!==page);
    document.querySelectorAll('#nav a').forEach(el=>{if(el.dataset.page===page)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');});
    $('page-title').textContent=pages[page][0]; $('page-subtitle').textContent=pages[page][1]; $('breadcrumb').textContent=pages[page][2];
    document.title=`${pages[page][2]} · Smart Fire Guard`;
    if($('sidebar').classList.contains('open'))toggleMenu(false);
    if(page!=='camera')stopCamera();
  }
  window.addEventListener('hashchange',route); route();

  async function request(path,options={}) {
    const controller=new AbortController(), timeout=setTimeout(()=>controller.abort(),8000);
    try {
      const res=await fetch(path,{...options,signal:controller.signal,headers:{Accept:'application/json',...options.headers}});
      if(!res.ok)throw Error(`Máy chủ trả lỗi HTTP ${res.status}`);
      const data=await res.json(); if(data.success!==true)throw Error(data.error||'Phản hồi không hợp lệ');
      return data;
    } finally {clearTimeout(timeout);}
  }
  async function fetchStatus() {
    const id=++statusRequest, revision=stateRevision;
    try {
      const data=await request('/api/status'); if(id!==statusRequest)return;
      if(!data.state||typeof data.state!=='object')throw Error('Thiếu trạng thái hệ thống');
      // Thresholds are independent of telemetry; do not lose them when a socket update wins a race.
      if(data.thresholds&&metrics.every(m=>finite(data.thresholds[m.threshold]?.warn)&&finite(data.thresholds[m.threshold]?.danger))) thresholds=data.thresholds;
      renderThresholds();
      if(revision!==stateRevision) {render();return;}
      serverOnline=true;
      acceptState(data.state, !socket?.connected);
    } catch(err) {
      if(id!==statusRequest||revision!==stateRevision)return;
      serverOnline=false; render();
      toast(err.name==='AbortError'?'Máy chủ phản hồi quá chậm.':err.message);
    }
  }
  function acceptState(next,record=true) {
    const now=Date.now();
    // HTTP status can return the same old hardware reading; a successful GET is not a fresh sensor ping.
    const ping=Date.parse(next.lastEsp32Ping);
    telemetryStale=next.esp32Connected===true&&(!Number.isFinite(ping)||now-ping>=12000);
    state=next; lastReceived=now; stateRevision++;
    if(record || !samples.length) {
      samples.push({...next,receivedAt:now,demo:isDemo(next)}); samples=samples.slice(-120);
    }
    render(); renderSamples(); renderCharts();
  }
  function render() {
    const live=fresh() && !(state?.esp32Connected===true&&!deviceOnline()), online=deviceOnline(), demo=isDemo();
    const lv=live?overall():'unknown', [label,tone]=levels[lv];
    setBadge('server-status',serverOnline?'Máy chủ đã kết nối':'Mất kết nối máy chủ',serverOnline?'good':'danger');
    $('sidebar-dot').classList.toggle('online',serverOnline);
    $('sidebar-status').replaceChildren(document.createTextNode(serverOnline?'Máy chủ đã kết nối':'Máy chủ ngoại tuyến'),Object.assign(document.createElement('small'),{textContent:'Smart Fire Guard v1.0'}));
    $('connection-banner').hidden=serverOnline&&live;
    $('connection-banner').className=`notice ${state?'error':''}`;
    $('connection-banner').textContent=serverOnline?'Chưa có dữ liệu cảm biến mới. Các giá trị hiển thị có thể đã cũ.':state?'Mất kết nối máy chủ. Đang hiển thị bản nhận cuối; không thể xác nhận tình trạng hiện tại.':'Chưa có kết nối máy chủ. Đang chờ dữ liệu hoặc thử kết nối lại.';
    $('source-banner').hidden=!state||!demo; $('footer-source').textContent=sourceText();
    const titles={ok:demo?'Môi trường mô phỏng trong ngưỡng':'Các chỉ số đang trong ngưỡng',warn:demo?'DEMO · Có chỉ số vượt ngưỡng':'Cần kiểm tra chỉ số môi trường',bad:demo?'DEMO · Kịch bản nguy hiểm':'Phát hiện mức nguy hiểm',unknown:state?'Không đủ dữ liệu để đánh giá':'Đang chờ dữ liệu'};
    $('overall-title').textContent=titles[lv];
    $('overall-description').textContent=lv==='unknown'?'Kiểm tra kết nối, độ mới và tính hợp lệ của dữ liệu.':demo?'Đây là kết quả giả lập; trạng thái môi trường thực tế chưa được xác minh.':`Nguồn: ${sourceText()}. Tình trạng cảm biến vật lý chưa được API xác nhận.`;
    setBadge('overall-badge',label,tone);
    $('last-update').textContent=lastReceived?`Nhận lúc ${clock(lastReceived)}${live?'':' · Dữ liệu cũ'}`:'Chưa nhận bản cập nhật';
    $('metrics').innerHTML=metrics.map(m=>{
      const l=live?levelFor(m):'unknown';
      return `<article class="metric ${l==='bad'?'danger':''}"><div class="metric-top"><span class="metric-title">${m.label}</span><span class="metric-icon" aria-hidden="true">${m.icon}</span></div><div class="metric-value">${metricValue(m)}</div><div class="metric-foot">${badge(levels[l][0],levels[l][1])}<span>${!live?'Chờ dữ liệu mới':demo?'DEMO':m.key==='temperature'?'DHT11 / DHT22':'Chỉ số tương đối'}</span></div></article>`;
    }).join('')+`<article class="metric"><div class="metric-top"><span class="metric-title">Ngọn lửa</span><span class="metric-icon" aria-hidden="true">△</span></div><div class="metric-value" style="font-size:23px">${!state?'—':state.flame===true?'Có lửa':state.flame===false?'Không phát hiện':'Không hợp lệ'}</div><div class="metric-foot">${badge(!live?'Chưa xác định':state?.flame===true?'Phát hiện':state?.flame===false?'Không phát hiện':'Lỗi dữ liệu',!live?'neutral':state?.flame===true?'danger':state?.flame===false?'good':'warning')}<span>${demo?'DEMO':'Flame sensor'}</span></div></article>`;
    const deviceLabel=!state?'Chưa xác định':online?'Trực tuyến':!serverOnline?'Chưa xác minh':'Ngoại tuyến';
    const deviceTone=online?'good':'neutral'; setBadge('device-status',deviceLabel,deviceTone);
    $('device-light').classList.toggle('online',online);
    $('device-last-seen').textContent=state?.lastEsp32Ping&&Number.isFinite(Date.parse(state.lastEsp32Ping))?clock(state.lastEsp32Ping):'Chưa nhận';
    document.querySelectorAll('[data-device-name]').forEach(el=>el.textContent=deviceName);
    // Avoid recreating the editable/focusable table button on every tick.
    $('device-row-name').textContent=deviceName; $('device-row-location').textContent=`${deviceLocation||'Chưa cung cấp vị trí'} · ESP32`;
    $('device-row-status').innerHTML=badge(deviceLabel,deviceTone); $('device-row-time').textContent=$('device-last-seen').textContent;
    $('sensor-health').innerHTML=metrics.map(m=>{
      const good=valid(m),status=!state?'Chưa có dữ liệu':!good?'Dữ liệu thiếu / không hợp lệ':!live?'Dữ liệu đã cũ':demo?'DEMO · Không phải cảm biến thật':'Dữ liệu hợp lệ';
      return `<div class="health-item"><strong>${m.label}</strong><br>${badge(status,!good&&state?'danger':live&&!demo?'good':'neutral')}<p>${m.key==='temperature'?'Miền kiểm tra UI: −40 đến 125°C.':'Miền kiểm tra UI: 0–100% tương đối.'}</p></div>`;
    }).join('');
    setBadge('alert-source',sourceText(),demo?'demo':'neutral'); $('alert-count').textContent=lv==='bad'||lv==='warn'?'1':'—';
    $('active-alert').innerHTML=`${badge(label,tone)}<p>${escape(titles[lv])}</p><p>${metrics.map(m=>`${m.label}: ${valid(m)?escape(state[m.key])+m.unit:'không hợp lệ / chưa có'}`).join(' · ')}</p><p>${escape(sourceText())}${live?'':' · Chưa xác minh trạng thái hiện tại'}</p>`;
    $('export-samples').disabled=!samples.length; syncSound();
  }
  $('device-table').innerHTML='<tr><td><strong id="device-row-name"></strong><span class="muted" id="device-row-location"></span></td><td id="device-row-status"></td><td>Wi-Fi / HTTP</td><td id="device-row-time"></td><td><button class="button" id="edit-device">Sửa tên</button></td></tr>';
  $('edit-device').onclick=()=>$('device-name-input').focus();

  function chart(target,series) {
    const rows=samples.slice(-range);
    if(rows.length<2) {
      $(target).innerHTML='<p class="empty-state">'+(rows.length?'Đã nhận 1 mẫu. Đang chờ mẫu tiếp theo để vẽ xu hướng.':'Chưa có dữ liệu. Biểu đồ sẽ xuất hiện khi nhận ít nhất 2 mẫu.')+'</p>';return;
    }
    const w=700,h=240,left=42,right=16,top=16,bottom=36,pw=w-left-right,ph=h-top-bottom;
    const values=rows.flatMap(s=>series.filter(m=>valid(m,s)).map(m=>s[m.key]));
    if(!values.length) {$(target).innerHTML='<p class="empty-state">Không có giá trị hợp lệ để vẽ biểu đồ trong khoảng xem này.</p>';return;}
    const ymin=Math.min(0,...values),ymax=Math.max(100,...values),y=v=>top+(ymax-v)/(ymax-ymin)*ph;
    // Time-based x axis: missing intervals keep their actual duration.
    const first=rows[0].receivedAt,span=Math.max(1,rows[rows.length-1].receivedAt-first),x=i=>left+(rows[i].receivedAt-first)/span*pw;
    let svg=`<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Xu hướng ${escape(series.map(m=>m.label).join(', '))}. Mẫu DEMO được vẽ nét đứt.">`;
    for(let i=0;i<=4;i++) {
      const v=ymin+(ymax-ymin)*i/4;
      svg+=`<line class="chart-grid" x1="${left}" x2="${w-right}" y1="${y(v)}" y2="${y(v)}"/><text class="chart-label" x="${left-9}" y="${y(v)+4}" text-anchor="end">${Math.round(v)}</text>`;
    }
    for(const m of series) {
      let segment=[],segmentDemo=null;
      const flush=()=>{if(!segment.length)return;svg+=`<polyline class="chart-line" stroke="${m.color}" ${segmentDemo?'stroke-dasharray="5 5"':''} points="${segment.join(' ')}"/>`;segment=[];};
      rows.forEach((s,i)=>{
        if(!valid(m,s)){flush();return;}
        if(i&&(s.demo!==segmentDemo||s.receivedAt-rows[i-1].receivedAt>12000))flush();
        segmentDemo=s.demo; segment.push(`${x(i).toFixed(1)},${y(s[m.key]).toFixed(1)}`);
        svg+=`<circle cx="${x(i)}" cy="${y(s[m.key])}" r="2" fill="${m.color}"><title>${escape(clock(s.receivedAt))} · ${m.label}: ${s[m.key]}${m.unit} · ${s.demo?'DEMO':'ESP32'}</title></circle>`;
      });flush();
    }
    for(const i of [0,Math.floor((rows.length-1)/2),rows.length-1])svg+=`<text class="chart-label" x="${x(i)}" y="${h-8}" text-anchor="${i===0?'start':i===rows.length-1?'end':'middle'}">${clock(rows[i].receivedAt)}</text>`;
    $(target).innerHTML=svg+'</svg>';
  }
  function renderCharts() {
    chart('overview-chart',metrics); metrics.forEach(m=>chart(`chart-${m.key}`,[m]));
    $('sample-count').textContent=`${samples.length} mẫu trong phiên · Nét đứt = DEMO`;
  }
  $('sensor-charts').innerHTML=metrics.map(m=>`<article class="panel"><div class="panel-heading"><div><h2>${m.label} <span class="muted">/ ${m.unit}</span></h2><p>${m.key==='temperature'?'DHT11 / DHT22':'Chỉ số tương đối, chưa hiệu chuẩn nồng độ'} · dữ liệu nhận trong phiên · nét đứt = DEMO</p></div></div><div id="chart-${m.key}" class="chart-container"></div></article>`).join('');
  $('chart-range').onchange=e=>{range=Number(e.target.value);renderCharts();};

  function logSource(row) {
    const message=String(row.message||'');
    return message.includes('SIMULATION')?'DEMO':message.includes('ESP32_HARDWARE')?'ESP32':'Không xác định';
  }
  function renderLogs() {
    const filter=$('log-filter').value, rows=logs.filter(r=>filter==='all'||r.level===filter);
    const tone=r=>r.level==='DANGER'?'danger':r.level==='WARN'?'warning':'neutral';
    const label=r=>r.level==='DANGER'?'Nguy hiểm':r.level==='WARN'?'Cảnh báo':'Thông tin';
    $('log-feedback').className=logError?'notice error':''; $('log-feedback').textContent=logError;
    $('event-rows').innerHTML=rows.length?rows.map(r=>`<tr><td>${escape(r.formatted_time||r.timestamp||'—')}</td><td>${badge(label(r),tone(r))}</td><td>${escape(r.message)}</td><td>${badge(logSource(r),logSource(r)==='DEMO'?'demo':'neutral')}</td></tr>`).join(''):`<tr><td colspan="4" class="empty-state">${logsBusy?'Đang tải nhật ký…':logError?'Không tải được nhật ký. Chọn Tải lại để thử.':!logLoaded?'Chưa tải nhật ký.':filter!=='all'?'Không có sự kiện phù hợp bộ lọc.':'Chưa có sự kiện cảnh báo.'}</td></tr>`;
    $('recent-events').innerHTML=logs.length?logs.slice(0,3).map(r=>`<div class="event-item"><span class="event-symbol" aria-hidden="true">${r.level==='DANGER'?'!':r.level==='WARN'?'△':'↗'}</span><div class="event-copy"><p>${escape(r.message)}</p><small>${escape(label(r))} · ${escape(logSource(r))}</small></div><small>${escape(r.formatted_time||r.timestamp||'—')}</small></div>`).join(''):`<p class="empty-state">${logsBusy?'Đang tải nhật ký…':logError?'Không tải được nhật ký. Thử làm mới.':logLoaded?'Chưa có sự kiện.':'Đang chờ kết nối…'}</p>`;
  }
  async function fetchLogs() {
    if(logsBusy)return;logsBusy=true;renderLogs();
    try {
      const data=await request('/api/logs');
      if(!Array.isArray(data.logs)||data.logs.some(row=>!row||typeof row!=='object'))throw Error('Nhật ký trả về không hợp lệ');
      logs=data.logs;logError='';logLoaded=true;lastLogFetch=Date.now();
    } catch(err) {
      logError=`Không tải được nhật ký: ${err.name==='AbortError'?'quá thời gian chờ':err.message}${logs.length?'. Đang hiển thị dữ liệu đã tải trước đó.':''}`;
    } finally {logsBusy=false;renderLogs();}
  }
  $('log-filter').onchange=renderLogs; $('logs-refresh').onclick=fetchLogs;
  function renderSamples() {
    $('sensor-rows').innerHTML=samples.length?samples.slice().reverse().map(s=>`<tr><td>${clock(s.receivedAt)}</td>${[metrics[0],metrics[2],metrics[1]].map(m=>`<td>${valid(m,s)?escape(s[m.key])+m.unit:'Lỗi / thiếu'}</td>`).join('')}<td>${s.flame===true?'Có':s.flame===false?'Không':'Không rõ'}</td><td>${badge(sourceText(s),s.demo?'demo':'neutral')}</td></tr>`).join(''):'<tr><td colspan="6" class="empty-state">Chưa có mẫu trong phiên này. Dữ liệu sẽ xuất hiện khi kết nối máy chủ.</td></tr>';
  }
  function renderThresholds() {
    $('threshold-table').innerHTML=thresholds?`<table><thead><tr><th>Cảm biến</th><th>WARN</th><th>DANGER</th></tr></thead><tbody>${metrics.map(m=>`<tr><td>${m.label}</td><td>&gt; ${thresholds[m.threshold].warn}${m.unit}</td><td>&gt; ${thresholds[m.threshold].danger}${m.unit}</td></tr>`).join('')}</tbody></table>`:'<p class="empty-state">Chưa tải được ngưỡng từ máy chủ.</p>';
    if(thresholds&&!previewReady) {
      $('preview-inputs').innerHTML=metrics.map(m=>`<div class="preview-group"><h3>${m.label} (${m.unit})</h3><label>WARN<input type="number" step="0.1" min="${m.range[0]}" max="${m.range[1]}" id="${m.key}-warn" value="${thresholds[m.threshold].warn}" required></label><label>DANGER<input type="number" step="0.1" min="${m.range[0]}" max="${m.range[1]}" id="${m.key}-danger" value="${thresholds[m.threshold].danger}" required></label></div>`).join('');
      previewReady=true;
    }
  }
  $('threshold-preview').onsubmit=e=>{
    e.preventDefault();
    if(!previewReady||!state||!fresh()) {$('preview-result').textContent='Cần dữ liệu và ngưỡng còn mới từ máy chủ để xem trước.';return;}
    const proposed={};
    for(const m of metrics) {
      const warn=Number($(`${m.key}-warn`).value),danger=Number($(`${m.key}-danger`).value);
      if(!finite(warn)||!finite(danger)||warn>=danger) {$('preview-result').textContent=`${m.label}: WARN phải nhỏ hơn DANGER.`;return;}
      proposed[m.threshold]={warn,danger};
    }
    $('preview-result').textContent='XEM TRƯỚC · '+metrics.map(m=>`${m.label}: ${levels[levelFor(m,state,proposed)][0]}`).join(' · ')+'. Chưa lưu lên server; không thay đổi đánh giá ngọn lửa hoặc cảnh báo tổng.';
  };
  $('device-name-input').value=deviceName; $('device-location-input').value=deviceLocation;
  $('device-endpoint').textContent=`${location.origin}/api/sensor-data`;
  $('device-form').onsubmit=e=>{
    e.preventDefault();const name=$('device-name-input').value.trim();if(!name){toast('Tên thiết bị không được để trống.');return;}
    deviceName=name; deviceLocation=$('device-location-input').value.trim();
    const a=storage.set('fg-device-name',deviceName),b=storage.set('fg-device-location',deviceLocation);
    render(); toast(a&&b?'Đã lưu thông tin hiển thị trên trình duyệt này.':'Đã cập nhật trong phiên. Không thể lưu vào trình duyệt.');
  };

  async function initAudio() {
    if(!audioCtx) {const Audio=window.AudioContext||window.webkitAudioContext;if(!Audio)throw Error('Trình duyệt không hỗ trợ âm thanh cảnh báo.');audioCtx=new Audio();}
    await audioCtx.resume(); if(audioCtx.state!=='running')throw Error('Cần cho phép âm thanh trong trình duyệt.');
  }
  function syncSound() {
    $('btn-sound').textContent=`Âm thanh: ${soundEnabled?'Bật':'Tắt'}`;
    $('btn-sound').setAttribute('aria-pressed',String(soundEnabled)); $('sound-setting').textContent=soundEnabled?'Bật':'Tắt';
    if(soundEnabled&&overall()==='bad'&&audioCtx?.state==='running') {
      if(!oscillator) {oscillator=audioCtx.createOscillator();gain=audioCtx.createGain();oscillator.type='sawtooth';oscillator.frequency.value=880;gain.gain.value=.12;oscillator.connect(gain);gain.connect(audioCtx.destination);oscillator.start();}
    } else if(oscillator) {oscillator.stop();oscillator.disconnect();gain.disconnect();oscillator=null;}
  }
  $('btn-sound').onclick=async()=>{
    soundEnabled=!soundEnabled;storage.set('fg-sound',String(soundEnabled));
    if(soundEnabled) {try{await initAudio();$('audio-status').textContent='Âm thanh đã được cho phép trong phiên này.';}catch(err){$('audio-status').textContent=err.message;}}
    syncSound();
  };
  async function action(button,path,question) {
    if(question&&!window.confirm(question))return;button.disabled=true;
    try {
      if(path==='/api/simulate/fire'&&soundEnabled) {try{await initAudio();}catch(err){$('audio-status').textContent=err.message;}}
      await request(path,{method:'POST'}); await Promise.all([fetchStatus(),fetchLogs()]);toast('Thao tác đã hoàn tất.');
    } catch(err) {toast(`Thao tác thất bại: ${err.name==='AbortError'?'quá thời gian chờ; hãy kiểm tra trạng thái trước khi thử lại':err.message}`);}
    finally {button.disabled=false;}
  }
  $('sim').onclick=()=>action($('sim'),'/api/simulate/fire','Kích hoạt DEMO cháy trên state chung của server? Nếu ESP32 đang kết nối, kết quả có thể ảnh hưởng lệnh còi trả về thiết bị.');
  $('rst').onclick=()=>action($('rst'),'/api/reset','Reset sẽ thay số đo trên server bằng giá trị mặc định, kể cả khi thiết bị đang kết nối. Thao tác không chứng minh môi trường đã an toàn. Tiếp tục?');
  $('clear-log-btn').onclick=()=>action($('clear-log-btn'),'/api/logs/clear','Xóa nhật ký cảnh báo trên server cho mọi người dùng? Dữ liệu cảm biến không bị xóa.');
  $('refresh').onclick=async()=>{$('refresh').disabled=true;try{await Promise.all([fetchStatus(),fetchLogs()]);}finally{$('refresh').disabled=false;}};
  $('export-samples').onclick=()=>{
    const csv=['received_at,temperature_c,smoke_relative_pct,gas_relative_pct,flame,source',...samples.map(s=>[new Date(s.receivedAt).toISOString(),...['temperature','smoke','gas'].map(k=>finite(s[k])?s[k]:''),s.flame===true?1:s.flame===false?0:'',s.demo?'DEMO':'ESP32_HARDWARE'].join(','))].join('\r\n');
    const url=URL.createObjectURL(new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8;'})),a=document.createElement('a');
    a.href=url;a.download='fireguard-session.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };

  function stopCamera() {
    cameraEpoch++;cameraPending=false;
    if(stream)stream.getTracks().forEach(track=>{track.onended=null;track.stop();});stream=null;
    clearInterval(frameTimer);frameTimer=null;
    $('localWebcam').srcObject=null;$('localWebcam').hidden=true;$('camera-placeholder').hidden=false;
    $('camera-toggle').disabled=false;$('camera-toggle').textContent='Bật camera';$('camera-status').textContent='Camera đã tắt. Không gửi ảnh.';
  }
  async function startCamera() {
    if(!navigator.mediaDevices?.getUserMedia) {toast('Webcam cần HTTPS hoặc localhost và trình duyệt hỗ trợ camera.');$('camera-status').textContent='Không thể truy cập webcam trên kết nối hiện tại.';return;}
    const epoch=++cameraEpoch;cameraPending=true;$('camera-toggle').disabled=true;$('camera-status').textContent='Đang chờ quyền truy cập camera…';
    try {
      const next=await navigator.mediaDevices.getUserMedia({video:{width:{ideal:640},height:{ideal:360}},audio:false});
      if(epoch!==cameraEpoch){next.getTracks().forEach(t=>t.stop());return;}
      stream=next;cameraPending=false;const video=$('localWebcam');video.srcObject=stream;await video.play();if(epoch!==cameraEpoch)return;
      video.hidden=false;$('camera-placeholder').hidden=true;$('camera-toggle').textContent='Tắt camera';
      $('camera-status').textContent='Webcam đang bật · AI DEMO: chờ kết quả mô phỏng.';
      const canvas=document.createElement('canvas');
      frameTimer=setInterval(()=>{
        if(!socket?.connected||video.readyState<2)return;const width=Math.min(640,video.videoWidth);if(!width)return;
        canvas.width=width;canvas.height=Math.round(width*video.videoHeight/video.videoWidth);
        canvas.getContext('2d').drawImage(video,0,0,canvas.width,canvas.height);
        socket.emit('analyze_ai_frame',{image:canvas.toDataURL('image/jpeg',.5)});
      },2000);
      stream.getTracks().forEach(track=>track.onended=()=>stopCamera());
    } catch(err) {
      if(epoch===cameraEpoch){stopCamera();$('camera-status').textContent=err.name==='NotAllowedError'?'Quyền camera bị từ chối. Hãy cho phép camera trong cài đặt trình duyệt.':`Không mở được camera (${err.name}). Kiểm tra kết nối hoặc thiết bị.`;}
    } finally {if(epoch===cameraEpoch){cameraPending=false;$('camera-toggle').disabled=false;}}
  }
  $('camera-toggle').onclick=()=>stream||cameraPending?stopCamera():startCamera();
  window.addEventListener('pagehide',stopCamera);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stopCamera();});
  if(typeof window.io==='function') {
    socket=window.io();
    socket.on('connect',()=>{serverOnline=true;fetchStatus();fetchLogs();});
    socket.on('disconnect',()=>{serverOnline=false;stateRevision++;render();if(stream)$('camera-status').textContent='Mất kết nối máy chủ. Webcam còn mở, không gửi ảnh; bạn có thể tắt camera.';});
    socket.on('connect_error',()=>{serverOnline=false;render();});
    socket.on('sensor_update',payload=>{
      if(payload?.state&&typeof payload.state==='object'){serverOnline=true;acceptState(payload.state);if(Date.now()-lastLogFetch>10000)fetchLogs();}
    });
    socket.on('logs_cleared',fetchLogs);
    socket.on('ai_result',result=>{
      if(stream&&typeof result?.hasFire==='boolean')$('camera-status').textContent=`DEMO · AI mô phỏng: ${result.hasFire?'Có nguy cơ cháy':'Không phát hiện'}${finite(Number(result.confidence))?' · độ tin cậy giả lập '+Number(result.confidence).toFixed(1)+'%':''}. Chưa kết nối YOLO.`;
    });
  } else {toast('Không tải được Socket.IO. Đang dùng cập nhật HTTP định kỳ.');}
  render();renderCharts();renderSamples();renderThresholds();renderLogs();fetchStatus();fetchLogs();
  setInterval(render,3000);
  setInterval(()=>{if(!document.hidden){fetchStatus();if(!socket?.connected)fetchLogs();}},10000);
})();
