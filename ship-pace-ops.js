/* SHIP PACE operations extension: worker identity, hourly snapshots and productivity. */
(function(){
  'use strict';
  const $=id=>document.getElementById(id);
  const opsUuid=()=>crypto.randomUUID?.()||`${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const opsIsoAt=time=>new Date(`${state.date}T${time}:00`).toISOString();
  const opsMinutesAt=iso=>{const d=new Date(iso);return d.getHours()*60+d.getMinutes()};
  const opsFormatDuration=mins=>`${Math.floor(mins/60)?Math.floor(mins/60)+'時間':''}${Math.round(mins%60)}分`;
  let opsCompletionCandidate=null,opsScanner=null,opsScannerMode='attendance',opsLinkWorkerId='',opsLastScan=new Map();

  function opsEnsureState(){
    state.workerMaster=Array.isArray(state.workerMaster)?state.workerMaster:[];
    state.workerSessions=Array.isArray(state.workerSessions)?state.workerSessions:[];
    state.staffingTimeline=Array.isArray(state.staffingTimeline)?state.staffingTimeline:[];
    state.progressCheckpoints=Array.isArray(state.progressCheckpoints)?state.progressCheckpoints:[];
    state.completionDismissals=Array.isArray(state.completionDismissals)?state.completionDismissals:[];
    state.workerMaster.forEach(w=>{w.id=w.id||opsUuid();w.name=w.name||'名称未設定';w.barcode=w.barcode||''});
  }
  function opsWorker(id){return state.workerMaster.find(w=>w.id===id)}
  function opsActiveSessions(at=new Date()){
    const time=at instanceof Date?at:new Date(at);
    return state.workerSessions.filter(s=>new Date(s.startAt)<=time&&(!s.endAt||new Date(s.endAt)>time));
  }
  function shipPaceCurrentWorkerCount(){return opsActiveSessions().length}
  window.shipPaceCurrentWorkerCount=shipPaceCurrentWorkerCount;
  function opsActiveIds(at=new Date()){return opsActiveSessions(at).map(s=>s.workerId)}
  function opsRecordStaffing(at,source,count=null,activeIds=null){
    const ids=activeIds||opsActiveIds(new Date(at));
    state.staffingTimeline.push({id:opsUuid(),at,source,count:count===null?ids.length:Number(count)||0,activeWorkerIds:[...ids]});
    state.staffingTimeline=state.staffingTimeline.sort((a,b)=>new Date(a.at)-new Date(b.at)).slice(-2000);
  }
  function opsLatestStaffingAt(at){
    const t=at instanceof Date?at:new Date(at),events=state.staffingTimeline.filter(e=>new Date(e.at)<=t).sort((a,b)=>new Date(a.at)-new Date(b.at));
    return events.at(-1)||{count:0,activeWorkerIds:[]};
  }
  function opsProductiveMinutes(start,end){
    if(end<=start)return 0;
    let total=(end-start)/60000;
    const day=new Date(start);state.breaks.forEach(([a,b])=>{const base=new Date(day.getFullYear(),day.getMonth(),day.getDate()),bs=new Date(base.getTime()+a*60000),be=new Date(base.getTime()+b*60000);total-=Math.max(0,(Math.min(end,be)-Math.max(start,bs))/60000)});
    return Math.max(0,total);
  }
  function opsStaffingSegments(start,end){
    const events=state.staffingTimeline.filter(e=>new Date(e.at)>start&&new Date(e.at)<end).sort((a,b)=>new Date(a.at)-new Date(b.at));
    let cursor=new Date(start),current=opsLatestStaffingAt(cursor),segments=[];
    [...events,{at:new Date(end).toISOString(),count:current.count,activeWorkerIds:current.activeWorkerIds}].forEach(event=>{const stop=new Date(event.at),minutes=opsProductiveMinutes(cursor,stop);if(stop>cursor&&minutes>0)segments.push({start:new Date(cursor),end:stop,minutes,count:Number(current.count)||0,workerIds:[...(current.activeWorkerIds||[])]});cursor=stop;current=event});
    return segments;
  }
  function opsHumanMinutes(start,end){return opsStaffingSegments(start,end).reduce((sum,x)=>sum+x.minutes*x.count,0)}

  async function opsSetWorkerActive(workerId,active,source='barcode'){
    opsEnsureState();const worker=opsWorker(workerId);if(!worker)return;
    const now=new Date(),session=state.workerSessions.find(s=>s.workerId===workerId&&!s.endAt);
    if(active&&session){$('attendanceMessage').textContent=`${worker.name}さんはすでに作業中です。`;return}
    if(!active&&!session){$('attendanceMessage').textContent=`${worker.name}さんは現在作業中ではありません。`;return}
    if(active)state.workerSessions.push({id:opsUuid(),workerId,startAt:now.toISOString(),endAt:null,startSource:source});
    else{session.endAt=now.toISOString();session.endSource=source}
    opsRecordStaffing(now.toISOString(),source);
    state.workers=shipPaceCurrentWorkerCount();state.effectiveTime=clock(nowMinutes());
    await saveState(active?'shipping_worker_start':'shipping_worker_end');
    $('attendanceMessage').textContent=`${worker.name}さんが${active?'作業開始・参加':'作業終了・退出'}しました。現在${shipPaceCurrentWorkerCount()}名です。`;
  }
  async function toggleWorkerAttendance(workerId,source='manual'){const active=Boolean(state.workerSessions.find(s=>s.workerId===workerId&&!s.endAt));await opsSetWorkerActive(workerId,!active,source)}
  window.toggleWorkerAttendance=toggleWorkerAttendance;
  window.endActiveWorker=id=>opsSetWorkerActive(id,false,'manual_end');

  function renderActiveWorkers(){
    const active=opsActiveSessions(),list=$('activeWorkerList');$('activeWorkerCount').textContent=`${active.length}名`;
    list.innerHTML=active.length?active.map(s=>{const w=opsWorker(s.workerId),mins=Math.max(0,Math.floor((Date.now()-new Date(s.startAt))/60000));return `<div class="active-worker-row"><div><b>${escapeHtml(w?.name||'不明な作業者')}</b><small>${new Date(s.startAt).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'})}〜　作業中${opsFormatDuration(mins)}</small></div><button class="secondary" onclick="endActiveWorker('${s.workerId}')">終了</button></div>`}).join(''):'<div class="history-item"><span>現在作業中の作業者はいません</span></div>';
  }
  async function addWorkerMaster(){
    const input=$('newWorkerName'),name=input.value.trim();if(!name){$('workerMasterMessage').textContent='作業者名を入力してください。';return}
    state.workerMaster.push({id:opsUuid(),name,barcode:'',createdAt:new Date().toISOString()});input.value='';await saveState('shipping_worker_master');$('workerMasterMessage').textContent=`${name}さんを追加しました。`;
  }
  window.addWorkerMaster=addWorkerMaster;
  function renderWorkerMaster(){
    $('workerMasterList').innerHTML=state.workerMaster.length?state.workerMaster.map(w=>`<div class="master-row"><div><b>${escapeHtml(w.name)}</b><small>${w.barcode?`バーコード ${escapeHtml(w.barcode)}`:'バーコード未登録'}</small></div><div class="controls"><button class="secondary" onclick="renameWorker('${w.id}')">名前変更</button><button class="secondary" onclick="openWorkerScanner('link','${w.id}')">${w.barcode?'変更':'バーコードを登録'}</button>${w.barcode?`<button class="secondary" onclick="unlinkWorkerBarcode('${w.id}')">解除</button>`:''}</div></div>`).join(''):'<div class="history-item"><span>作業者を登録してください</span></div>';
  }
  async function renameWorker(id){const w=opsWorker(id),name=prompt('新しい作業者名',w?.name||'');if(!w||!name?.trim())return;w.name=name.trim();await saveState('shipping_worker_master')}
  async function unlinkWorkerBarcode(id){const w=opsWorker(id);if(!w||!w.barcode||!confirm(`${w.name}さんのバーコード紐付けを解除しますか？`))return;w.barcode='';await saveState('shipping_barcode_link');$('workerMasterMessage').textContent='バーコードの紐付けを解除しました。過去実績は保持されています。'}
  window.renameWorker=renameWorker;window.unlinkWorkerBarcode=unlinkWorkerBarcode;
  async function opsLinkBarcode(workerId,barcode){
    const worker=opsWorker(workerId),duplicate=state.workerMaster.find(w=>w.barcode===barcode&&w.id!==workerId);if(!worker)return false;
    if(duplicate){$('barcodeMessage').textContent=`このバーコードは${duplicate.name}さんに登録されています。`;return false}
    worker.barcode=barcode;await saveState('shipping_barcode_link');$('attendanceMessage').textContent=`${worker.name}さんに${barcode}を登録しました。`;closeWorkerScanner();return true;
  }
  function renderUnregisteredChoices(barcode){
    $('barcodeMessage').textContent=`未登録のバーコードです：${barcode}　誰に紐付けますか？`;
    $('unregisteredWorkerChoices').innerHTML=state.workerMaster.map(w=>`<button class="secondary" onclick="linkUnknownBarcode('${w.id}','${escapeHtml(barcode)}')">${escapeHtml(w.name)}</button>`).join('')+`<button class="primary" onclick="createWorkerForBarcode('${escapeHtml(barcode)}')">新しい作業者を登録</button>`;
  }
  window.linkUnknownBarcode=(id,barcode)=>opsLinkBarcode(id,barcode);
  window.createWorkerForBarcode=async barcode=>{const name=prompt('新しい作業者名');if(!name?.trim())return;const worker={id:opsUuid(),name:name.trim(),barcode:'',createdAt:new Date().toISOString()};state.workerMaster.push(worker);await opsLinkBarcode(worker.id,barcode)};
  async function opsHandleBarcode(raw){
    const barcode=String(raw||'').trim();if(!barcode)return;const last=opsLastScan.get(barcode)||0;if(Date.now()-last<2800)return;opsLastScan.set(barcode,Date.now());
    if(opsScannerMode==='link'){await opsLinkBarcode(opsLinkWorkerId,barcode);return}
    const worker=state.workerMaster.find(w=>w.barcode===barcode);if(!worker){renderUnregisteredChoices(barcode);return}
    closeWorkerScanner();await toggleWorkerAttendance(worker.id,'barcode');
  }
  async function openWorkerScanner(mode='attendance',workerId=''){
    opsScannerMode=mode;opsLinkWorkerId=workerId;$('barcodeModal').classList.add('open');$('barcodeModalTitle').textContent=mode==='link'?`${opsWorker(workerId)?.name||''}さんのバーコード登録`:'作業者バーコードを読み取る';$('barcodeMessage').textContent='';$('unregisteredWorkerChoices').innerHTML='';$('manualBarcode').value='';
    if(!window.ZXing){$('barcodeModalHelp').textContent='カメラ読取を準備できませんでした。番号を手入力してください。';return}
    try{opsScanner=new ZXing.BrowserMultiFormatReader();await opsScanner.decodeFromVideoDevice(undefined,$('barcodeVideo'),(result)=>{if(result)opsHandleBarcode(result.getText())})}catch{$('barcodeModalHelp').textContent='カメラを利用できません。許可設定を確認するか、番号を手入力してください。'}
  }
  function closeWorkerScanner(){try{opsScanner?.reset()}catch{}opsScanner=null;$('barcodeVideo').srcObject?.getTracks?.().forEach(t=>t.stop());$('barcodeModal').classList.remove('open')}
  function submitManualBarcode(){opsHandleBarcode($('manualBarcode').value)}
  window.openWorkerScanner=openWorkerScanner;window.closeWorkerScanner=closeWorkerScanner;window.submitManualBarcode=submitManualBarcode;
  function openManualAttendance(){$('manualAttendanceModal').classList.add('open');renderManualAttendance()}
  function closeManualAttendance(){$('manualAttendanceModal').classList.remove('open')}
  function renderManualAttendance(){$('manualAttendanceList').innerHTML=state.workerMaster.map(w=>{const active=Boolean(state.workerSessions.find(s=>s.workerId===w.id&&!s.endAt));return `<div class="master-row"><div><b>${escapeHtml(w.name)}</b><small>${active?'作業中':'待機中'}</small></div><button class="${active?'secondary':'primary'}" onclick="toggleWorkerAttendance('${w.id}','manual').then(renderManualAttendance)">${active?'終了':'開始・参加'}</button></div>`}).join('')||'<div class="history-item">作業者マスターへ先に登録してください</div>'}
  window.openManualAttendance=openManualAttendance;window.closeManualAttendance=closeManualAttendance;window.renderManualAttendance=renderManualAttendance;

  function opsTargetMinutes(){
    const start=minutes(state.operationStart||'09:30'),final=Math.max(start,...state.waves.filter(w=>w.planned>0).map(w=>minutes(w.cutoff)));let out=[];for(let t=start+60;t<=final;t+=60)out.push(t);if(!out.includes(final)&&final>start)out.push(final);return [...new Set(out)].sort((a,b)=>a-b);
  }
  function opsTargetIso(targetMinute){return opsIsoAt(clock(targetMinute))}
  function opsCheckpoint(targetMinute){return state.progressCheckpoints.find(x=>x.targetMinute===targetMinute)}
  function opsCheckpointTotalAt(targetMinute){if(targetMinute===minutes(state.operationStart||'09:30'))return 0;return opsCheckpoint(targetMinute)?.totalCompleted}
  function opsPlanCumulativeAt(targetMinute){
    const groups=[],planned=state.waves.filter(w=>w.planned>0);planned.forEach(w=>{let g=groups.find(x=>x.cutoff===w.cutoff);if(!g){g={cutoff:w.cutoff,deadline:minutes(w.cutoff),planned:0};groups.push(g)}g.planned+=w.planned});groups.sort((a,b)=>a.deadline-b.deadline);
    let cursor=minutes(state.operationStart||'09:30'),total=0;for(const g of groups){const full=workingMinutes(cursor,g.deadline),elapsed=workingMinutes(cursor,Math.min(targetMinute,g.deadline));if(targetMinute>=g.deadline)total+=g.planned;else if(targetMinute>cursor&&full>0)total+=g.planned*(elapsed/full);cursor=g.deadline;if(targetMinute<g.deadline)break}return Math.round(total);
  }
  function opsLatestCheckpoint(now=nowMinutes()){return [...state.progressCheckpoints].filter(x=>x.targetMinute<=now).sort((a,b)=>a.targetMinute-b.targetMinute).at(-1)||null}
  function opsNextTarget(){const times=opsTargetMinutes(),now=nowMinutes(),missing=times.find(t=>t<=now&&!opsCheckpoint(t));return missing??times.find(t=>t>now)??times.at(-1)??minutes(state.operationStart||'09:30')}
  function renderProgressTarget(){
    const select=$('progressTargetTime'),current=Number(select.value),times=opsTargetMinutes();select.innerHTML=times.map(t=>`<option value="${t}">${clock(t)}時点${opsCheckpoint(t)?'（入力済み）':''}</option>`).join('');const target=times.includes(current)?current:opsNextTarget();if(Number.isFinite(target))select.value=String(target);renderProgressTiming();
  }
  function renderProgressTiming(){const target=Number($('progressTargetTime')?.value),checkpoint=opsCheckpoint(target);if(!Number.isFinite(target))return;const delay=nowMinutes()-target;$('progressTitle').textContent=`${clock(target)}時点の進捗`;$('progressTimingMessage').textContent=delay>0?`現在時刻 ${clock(nowMinutes())}・${delay}分遅れて入力しています`:delay===0?'現在時刻の対象データです':`${clock(target)}時点の後入力・修正ができます`;if(checkpoint){const wave=checkpoint.waveValues?.[$('quickWave').value];if(wave!==undefined)$('quickCompleted').value=wave}}
  $('progressTargetTime').addEventListener('change',renderProgressTiming);

  function opsIntervalRows(){
    const start=minutes(state.operationStart||'09:30'),times=[start,...opsTargetMinutes()],rows=[];let cumPlan=0;
    for(let i=1;i<times.length;i++){const a=times[i-1],b=times[i],startTotal=opsCheckpointTotalAt(a),endTotal=opsCheckpointTotalAt(b),actual=startTotal===undefined||endTotal===undefined?null:Number(endTotal)-Number(startTotal),planStart=opsPlanCumulativeAt(a),planEnd=opsPlanCumulativeAt(b),plan=Math.max(0,planEnd-planStart),humanMinutes=opsHumanMinutes(new Date(opsTargetIso(a)),new Date(opsTargetIso(b)));cumPlan=planEnd;rows.push({start:a,end:b,plan,actual,humanMinutes,productivity:actual===null||!humanMinutes?null:actual/(humanMinutes/60),cumulativeActual:endTotal,cumulativePlan:cumPlan,cumulativeHumanMinutes:opsHumanMinutes(new Date(opsTargetIso(start)),new Date(opsTargetIso(b)))})}return rows;
  }
  function opsDiffLabel(diff,word='計画'){return diff>0?`＋${diff}店舗　${word}以上 ↑`:diff<0?`−${Math.abs(diff)}店舗　${word}より遅れ ↓`:`±0店舗　${word}どおり`}
  function renderHourlyProductivity(){
    const rows=opsIntervalRows();$('hourlyProductivity').innerHTML=rows.map(x=>{const diff=x.actual===null?null:x.actual-x.plan,progressing=nowMinutes()>x.start&&nowMinutes()<x.end;return `<article class="hourly-card"><header><h3>${clock(x.start)}〜${clock(x.end)} ${progressing?'<small>進行中</small>':''}</h3></header><div class="hourly-main">計画 ${x.plan.toLocaleString()}店舗 ｜ 実績 ${x.actual===null?'未入力':x.actual.toLocaleString()+'店舗'}</div>${diff===null?'':`<p class="${diff<0?'late-note':''}">${opsDiffLabel(diff)}</p>`}<div class="hourly-main">${x.actual===null?'―':x.actual.toLocaleString()+'店舗'} ｜ ${(x.humanMinutes/60).toFixed(2)}人時</div><div class="hourly-main">${x.productivity===null?'未確定':x.productivity.toFixed(1)+'店舗/人時'}</div><div class="hourly-sub">累計実績 ${x.cumulativeActual===undefined?'未入力':Number(x.cumulativeActual).toLocaleString()+'店舗'} ｜ 累計計画 ${x.cumulativePlan.toLocaleString()}店舗 ｜ 累計 ${(x.cumulativeHumanMinutes/60).toFixed(2)}人時</div></article>`}).join('')||'<div class="history-item">開始時刻と計画を保存すると表示されます</div>';
  }

  function opsPerformanceAllocation(){
    const people=new Map(),joint=[],rows=opsIntervalRows();rows.filter(x=>x.actual!==null&&x.actual>=0).forEach(row=>{const segments=opsStaffingSegments(new Date(opsTargetIso(row.start)),new Date(opsTargetIso(row.end))).filter(s=>s.count>0&&s.minutes>0),totalSegmentMinutes=segments.reduce((s,x)=>s+x.minutes,0);segments.forEach(seg=>{const processed=totalSegmentMinutes?row.actual*(seg.minutes/totalSegmentMinutes):0,estimated=segments.length>1;if(seg.workerIds.length===1&&seg.count===1){const id=seg.workerIds[0],p=people.get(id)||{workerId:id,minutes:0,processed:0,estimated:false};p.minutes+=seg.minutes;p.processed+=processed;p.estimated ||= estimated;people.set(id,p)}else if(seg.workerIds.length>=2){joint.push({members:seg.workerIds,from:seg.start,to:seg.end,minutes:seg.minutes,processed,humanMinutes:seg.minutes*seg.count,estimated:true})}})});return{people:[...people.values()],joint};
  }
  function renderPerformance(){
    const result=opsPerformanceAllocation(),ranked=result.people.map(p=>({...p,rate:p.minutes?p.processed/(p.minutes/60):0,worker:opsWorker(p.workerId)})).sort((a,b)=>b.rate-a.rate),eligible=ranked.filter(x=>x.minutes>=30),reference=ranked.filter(x=>x.minutes<30);
    $('personalRanking').innerHTML=(eligible.map((x,i)=>`<div class="ranking-row"><span class="rank-number">${i+1}位</span><div><b>${escapeHtml(x.worker?.name||'不明')}</b><small>単独作業 ${opsFormatDuration(x.minutes)}／対象 ${Math.round(x.processed)}店舗${x.estimated?'（時間按分推定）':''}</small></div><strong>${x.rate.toFixed(1)}店舗/時</strong></div>`).join('')||'<div class="history-item">単独作業30分以上の記録はまだありません</div>')+(reference.length?`<details class="details-panel" style="margin-top:10px"><summary>参考記録 ${reference.length}名</summary><div class="details-inner">${reference.map(x=>`<div class="history-item"><span>${escapeHtml(x.worker?.name||'不明')} ${x.rate.toFixed(1)}店舗/時</span><small>単独${opsFormatDuration(x.minutes)}</small></div>`).join('')}</div></details>`:'');
    $('jointCount').textContent=`${result.joint.length}件`;$('jointWorkResults').innerHTML=result.joint.length?result.joint.map(x=>`<div class="history-item"><span><b>${x.members.map(id=>escapeHtml(opsWorker(id)?.name||'不明')).join('＋')}</b><br>${new Date(x.from).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'})}〜${new Date(x.to).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'})}・${Math.round(x.processed)}店舗（時間按分推定）</span><small>${opsFormatDuration(x.minutes)}／${(x.humanMinutes/60).toFixed(2)}人時／${x.humanMinutes?(x.processed/(x.humanMinutes/60)).toFixed(1):'0.0'}店舗/人時</small></div>`).join(''):'<div class="history-item">共同作業実績はまだありません</div>';
  }

  function renderProgressStatus(){
    const times=opsTargetMinutes(),now=nowMinutes(),missing=times.find(t=>t<=now&&!opsCheckpoint(t));$('snapshotStatus').innerHTML=times.map(t=>{const cp=opsCheckpoint(t),kind=cp?'done':t<=now?'missing':'',label=cp?'✓ 入力済み':t<=now?'⚠ 未入力':'― これから';return `<span class="snapshot-chip ${kind}">${clock(t)}　${label}</span>`}).join('');
    const reminder=$('progressReminder');if(missing!==undefined){const late=Math.max(0,now-missing);reminder.hidden=false;reminder.innerHTML=`<b>⚠ ${clock(missing)}時点の進捗が未入力です</b><p>${late?`現在${late}分遅れです。`:'累計完了店舗数を入力してください。'}</p><button class="primary" onclick="goToProgressTarget(${missing})">進捗入力へ</button>`}else reminder.hidden=true;
  }
  function goToProgressTarget(target){$('progressTargetTime').value=String(target);renderProgressTiming();$('progressPanel').scrollIntoView({behavior:'smooth',block:'start'})}
  window.goToProgressTarget=goToProgressTarget;
  function renderDashboard(){
    const latest=opsLatestCheckpoint(),target=latest?.targetMinute??minutes(state.operationStart||'09:30'),actual=latest?.totalCompleted??0,plan=opsPlanCumulativeAt(target),diff=actual-plan,human=opsHumanMinutes(new Date(opsTargetIso(minutes(state.operationStart||'09:30'))),new Date(opsTargetIso(target))),productivity=human?actual/(human/60):null,current=shipPaceCurrentWorkerCount(),next=groupedRows().find(x=>x.item.planned>0&&!x.item.completedAt),required=next?requiredWorkersFor(next,nowMinutes()):0,gap=required>=99?null:required-current,action=gap===null?'至急、配置を確認':gap>0?`${gap}名増員推奨`:gap<0?`${Math.abs(gap)}名余力あり`:'増員不要';
    let finish='実績蓄積中';if(next){const forecast=forecastFor(next);if(/^\d{2}:\d{2}$/.test(forecast)){const delta=minutes(forecast)-next.deadline;finish=Math.abs(delta)<=2?'予定どおり完了見込み':`予定より約${Math.abs(delta)}分${delta<0?'早く':'遅れて'}完了見込み`}}
    const nextTarget=opsNextTarget(),cp=opsCheckpoint(nextTarget),tone=diff>0?'ahead':diff<0?'behind':'on-plan';$('currentProgressDashboard').innerHTML=`<div class="ops-dashboard-head"><div><div class="eyebrow">CURRENT PROGRESS</div><h2>現在の進捗</h2></div><span class="ops-asof">${latest?clock(target)+'時点':'実績待ち'}</span></div><div class="ops-variance ${tone}">${opsDiffLabel(diff,'計画')}</div><div class="ops-dashboard-grid"><div class="ops-kpi"><small>計画累計｜実績累計</small><strong>${plan.toLocaleString()}｜${actual.toLocaleString()}店舗</strong></div><div class="ops-kpi"><small>累計 全体生産性</small><strong>${productivity===null?'実績待ち':productivity.toFixed(1)+' 店舗/人時'}</strong></div><div class="ops-kpi"><small>完了見込み</small><strong>${finish}</strong></div><div class="ops-kpi"><small>現在人数｜必要人数</small><strong>${current}名｜${required>=99?'算出不可':required+'名'}</strong></div><div class="ops-kpi"><small>最新の進捗入力</small><strong>${cp?'✓ 入力済み':nextTarget<=nowMinutes()?'⚠ 未入力':'― これから'}</strong></div></div><div class="ops-action ${gap>0||gap===null?'warn':''}">${action}</div>`;
  }

  const opsLegacyRender=render;
  render=function(){opsEnsureState();opsLegacyRender();renderProgressTarget();renderDashboard();renderActiveWorkers();renderProgressStatus();renderHourlyProductivity();renderPerformance();renderWorkerMaster()};

  function recordProgressCheckpoint({id,completed,targetMinute,inputAt=new Date().toISOString(),source='manual_snapshot'}){
    const targetAt=opsTargetIso(targetMinute);let legacy=state.progressSnapshots.find(x=>x.waveId===id&&Number(x.targetMinute)===targetMinute);if(legacy)Object.assign(legacy,{completed,at:targetAt,targetAt,inputAt,source});else state.progressSnapshots.push({id:opsUuid(),waveId:id,completed,interval:0,at:targetAt,targetAt,inputAt,targetMinute,source});
    let checkpoint=opsCheckpoint(targetMinute);const priorValues=checkpoint?.waveValues||{};const waveValues=Object.fromEntries(state.waves.map(w=>{if(w.id===id)return[w.id,completed];if(priorValues[w.id]!==undefined)return[w.id,Number(priorValues[w.id])||0];const prior=state.progressSnapshots.filter(x=>x.waveId===w.id&&Number(x.targetMinute)<=targetMinute).sort((a,b)=>Number(a.targetMinute)-Number(b.targetMinute)).at(-1);return[w.id,Number(prior?.completed)||0]})),totalCompleted=Object.values(waveValues).reduce((s,value)=>s+(Number(value)||0),0);if(checkpoint)Object.assign(checkpoint,{inputAt,totalCompleted,waveValues,updatedAt:inputAt});else state.progressCheckpoints.push({id:opsUuid(),targetMinute,targetAt,inputAt,totalCompleted,waveValues,createdAt:inputAt});state.progressCheckpoints.sort((a,b)=>a.targetMinute-b.targetMinute);state.progressSnapshots=state.progressSnapshots.slice(-1000);
    state.waves.forEach(w=>{const latest=state.progressSnapshots.filter(x=>x.waveId===w.id).sort((a,b)=>new Date(a.targetAt||a.at)-new Date(b.targetAt||b.at)).at(-1);if(latest)w.completed=Number(latest.completed)||0});return{checkpoint,totalCompleted,targetAt,inputAt};
  }
  window.shipPaceRecordProgressCheckpoint=recordProgressCheckpoint;
  async function opsSaveSnapshot(){
    const id=$('quickWave').value,item=state.waves.find(x=>x.id===id),completed=Math.max(0,Math.round(Number($('quickCompleted').value)||0)),targetMinute=Number($('progressTargetTime').value);if(!item||!Number.isFinite(targetMinute))return;
    const {checkpoint}=recordProgressCheckpoint({id,completed,targetMinute});
    await saveState(checkpoint?'shipping_snapshot_edit':'shipping_interval_progress');$('quickResult').scrollIntoView({behavior:'smooth',block:'center'});
    if(item.planned>0&&completed>=item.planned&&!item.completedAt&&!state.completionDismissals.some(x=>x.waveId===id&&x.targetMinute===targetMinute)){opsCompletionCandidate={waveId:id,targetMinute};$('completionPrompt').textContent=`${item.area}は計画${item.planned}店舗に到達しました（実績${completed}店舗）。この便の出荷作業は完了しましたか？`;$('completionModal').classList.add('open')}
  }
  saveQuickProgress=opsSaveSnapshot;
  async function confirmReachedWave(){const candidate=opsCompletionCandidate;if(!candidate)return;$('completionModal').classList.remove('open');opsCompletionCandidate=null;await completeWave(candidate.waveId);$('quickResult').innerHTML=`<strong>${escapeHtml(state.waves.find(x=>x.id===candidate.waveId)?.area||'便')}を完了しました</strong><p>方面別 出荷締切へ反映し、次便の必要ペースと終了予測を再計算しました。</p>`}
  async function dismissReachedWave(){const c=opsCompletionCandidate;if(c){const item=state.waves.find(x=>x.id===c.waveId),at=new Date().toISOString();if(item)item.completedAt=null;state.completionDismissals=state.completionDismissals.filter(x=>!(x.waveId===c.waveId&&x.targetMinute===c.targetMinute));state.completionDismissals.push({...c,at})}$('completionModal').classList.remove('open');opsCompletionCandidate=null;await saveState('shipping_completion_deferred');$('quickResult').insertAdjacentHTML('beforeend','<p><strong>未完了で保存しました。</strong> 便は完了扱いにせず、進捗だけを保存しています。</p>')}
  window.confirmReachedWave=confirmReachedWave;window.dismissReachedWave=dismissReachedWave;

  saveStartSettings=async function(){const next=operationStart.value||'09:30';state.operationStart=next;state.effectiveTime=next;state.staffingTimeline=[];opsRecordStaffing(opsIsoAt(next),'operation_start',shipPaceCurrentWorkerCount(),opsActiveIds());await saveState('shipping_start_change');workerMessage.textContent=`今日の計画開始を${next}に設定しました。作業者の人時は実際の参加時刻から計算します。`};
  applyWorkers=async function(){const count=Math.max(0,Number(workerChangeCount.value)||0),time=workerTime.value||clock(nowMinutes()),at=opsIsoAt(time);state.workers=count;state.effectiveTime=time;if(changeRateToggle.checked)state.onePersonRate=Math.max(1,Number(changeOnePersonRate.value)||state.onePersonRate);state.workerChanges.push({time,workers:count,onePersonRate:state.onePersonRate,operationStart:state.operationStart,kind:'manual_override',rateChanged:changeRateToggle.checked,savedAt:new Date().toISOString()});opsRecordStaffing(at,'manual_override',count,[]);await saveState('shipping_worker_change');workerMessage.textContent=`非常用修正：${time}から${count}名として人数タイムラインを修正しました。バーコード人数との二重計上はありません。`};
  const opsLegacyCompleteWave=completeWave;completeWave=async function(id){state.completionDismissals=state.completionDismissals.filter(x=>x.waveId!==id);await opsLegacyCompleteWave(id);render()};
  resetToday=async function(){if(!confirm('本日の完了店舗数・完了時刻・作業者記録をリセットしますか？'))return;state.waves.forEach(x=>{x.completed=0;x.completedAt=null});state.progressSnapshots=[];state.progressCheckpoints=[];state.workerSessions=[];state.staffingTimeline=[];state.completionDismissals=[];state.productivitySessions=(state.productivitySessions||[]).filter(x=>x.date!==state.date);state.activeProductivitySession=null;await saveState('shipping_reset');saveMessage.textContent='本日の実績・作業者・人数・進捗スナップショットをリセットしました。'};

  const opsLegacyReportText=reportText;reportText=function(){const latest=opsLatestCheckpoint(),human=latest?opsHumanMinutes(new Date(opsTargetIso(minutes(state.operationStart||'09:30'))),new Date(latest.targetAt)):0,allocation=opsPerformanceAllocation();return `${opsLegacyReportText()}\n\n【統合進捗】\n最新対象時刻 ${latest?clock(latest.targetMinute):'未入力'}\n累計全体生産性 ${latest&&human?(latest.totalCompleted/(human/60)).toFixed(1):'0.0'}店舗/人時\n現在作業中 ${shipPaceCurrentWorkerCount()}名\n時間帯進捗 ${state.progressCheckpoints.length}件\n共同作業区間 ${allocation.joint.length}件`};
  const opsLegacyReportSummary=reportSummary;reportSummary=function(){const base=opsLegacyReportSummary(),latest=opsLatestCheckpoint(),human=latest?opsHumanMinutes(new Date(opsTargetIso(minutes(state.operationStart||'09:30'))),new Date(latest.targetAt)):0;return{...base,currentWorkers:shipPaceCurrentWorkerCount(),workerMaster:state.workerMaster,workerSessions:state.workerSessions,staffingTimeline:state.staffingTimeline,progressCheckpoints:state.progressCheckpoints,hourlyProductivity:opsIntervalRows(),cumulativeHumanHours:human/60,cumulativeProductivity:latest&&human?latest.totalCompleted/(human/60):0,performance:opsPerformanceAllocation()}};

  function opsFoldSecondaryPanels(){
    const headings=['作業者別 生産性','翌日分の出荷計画','入力履歴・取り消し'];document.querySelectorAll('section.panel').forEach(section=>{const h=section.querySelector('h2');if(!h||!headings.includes(h.textContent.trim())||section.dataset.folded)return;const details=document.createElement('details');details.className=`panel details-panel ${section.classList.contains('future-panel')?'future-panel':''}`;details.dataset.folded='1';const summary=document.createElement('summary');summary.textContent=h.textContent;const inner=document.createElement('div');inner.className='details-inner';while(section.firstChild)inner.appendChild(section.firstChild);details.append(summary,inner);section.replaceWith(details)});
  }
  opsEnsureState();opsFoldSecondaryPanels();render();
})();
