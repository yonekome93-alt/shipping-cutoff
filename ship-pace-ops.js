/* SHIP PACE operations extension: worker identity, hourly snapshots and productivity. */
(function(){
  'use strict';
  const $=id=>document.getElementById(id);
  const opsUuid=()=>crypto.randomUUID?.()||`${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const opsIsoAt=time=>new Date(`${state.date}T${time}:00`).toISOString();
  const opsMinutesAt=iso=>{const d=new Date(iso);return d.getHours()*60+d.getMinutes()};
  const opsFormatDuration=mins=>`${Math.floor(mins/60)?Math.floor(mins/60)+'時間':''}${Math.round(mins%60)}分`;
  let opsCompletionCandidate=null,opsCompletionQueue=[],opsScanner=null,opsScannerMode='attendance',opsLinkWorkerId='',opsLastScan=new Map();

  function opsEnsureState(){
    state.workerMaster=Array.isArray(state.workerMaster)?state.workerMaster:[];
    state.workerSessions=Array.isArray(state.workerSessions)?state.workerSessions:[];
    state.staffingTimeline=Array.isArray(state.staffingTimeline)?state.staffingTimeline:[];
    state.progressCheckpoints=Array.isArray(state.progressCheckpoints)?state.progressCheckpoints:[];
    state.completionDismissals=Array.isArray(state.completionDismissals)?state.completionDismissals:[];
    state.workerMaster.forEach(w=>{w.id=w.id||opsUuid();w.name=w.name||'名称未設定';w.barcode=w.barcode||''});
    if(!state.staffingTimeline.length&&(state.workerSessions.length||state.workerChanges?.length))opsRebuildStaffingTimeline();
  }
  function opsWorker(id){return state.workerMaster.find(w=>w.id===id)}
  function opsActiveSessions(at=new Date()){
    const time=at instanceof Date?at:new Date(at);
    return state.workerSessions.filter(s=>new Date(s.startAt)<=time&&(!s.endAt||new Date(s.endAt)>time));
  }
  function shipPaceCurrentWorkerCount(at=new Date()){
    const time=at instanceof Date?at:new Date(at),hasTimeline=state.staffingTimeline.some(event=>new Date(event.at)<=time);
    if(!hasTimeline)return opsActiveSessions(time).length;
    const event=opsLatestStaffingAt(time);
    return Number.isFinite(Number(event?.count))?Math.max(0,Number(event.count)):opsActiveSessions(time).length;
  }
  window.shipPaceCurrentWorkerCount=shipPaceCurrentWorkerCount;
  function opsActiveIds(at=new Date()){return opsActiveSessions(at).map(s=>s.workerId)}
  function opsRecordStaffing(at,source,count=null,activeIds=null){
    const ids=activeIds||opsActiveIds(new Date(at));
    state.staffingTimeline.push({id:opsUuid(),at,source,count:count===null?ids.length:Number(count)||0,activeWorkerIds:[...ids]});
    state.staffingTimeline=state.staffingTimeline.sort((a,b)=>new Date(a.at)-new Date(b.at)).slice(-2000);
  }
  function opsRebuildStaffingTimeline(){
    const events=[{at:opsIsoAt(state.operationStart||'09:30'),kind:'operation_start',count:0}];
    state.workerSessions.forEach(session=>{if(session.startAt)events.push({at:session.startAt,kind:'worker_start',workerId:session.workerId});if(session.endAt)events.push({at:session.endAt,kind:'worker_end',workerId:session.workerId})});
    (state.workerChanges||[]).filter(change=>change.kind==='manual_override').forEach(change=>events.push({at:opsIsoAt(change.time||state.operationStart||'09:30'),kind:'manual_override',count:Math.max(0,Number(change.workers)||0)}));
    events.sort((a,b)=>new Date(a.at)-new Date(b.at));const active=new Set(),timeline=[];
    events.forEach(event=>{if(event.kind==='worker_start')active.add(event.workerId);if(event.kind==='worker_end')active.delete(event.workerId);const count=event.kind==='manual_override'?event.count:active.size;timeline.push({id:opsUuid(),at:event.at,source:event.kind,count,activeWorkerIds:[...active]})});
    state.staffingTimeline=timeline.slice(-2000);
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
    const active=opsActiveSessions(),effective=shipPaceCurrentWorkerCount(),list=$('activeWorkerList'),manualDifference=effective-active.length;$('activeWorkerCount').textContent=`${effective}名`;
    const named=active.map(s=>{const w=opsWorker(s.workerId),mins=Math.max(0,Math.floor((Date.now()-new Date(s.startAt))/60000));return `<div class="active-worker-row"><div><b>${escapeHtml(w?.name||'不明な作業者')}</b><small>${new Date(s.startAt).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'})}〜　作業中${opsFormatDuration(mins)}</small></div><button class="secondary" onclick="endActiveWorker('${s.workerId}')">終了</button></div>`}).join('');
    const correction=manualDifference?`<div class="history-item"><span><b>手動補正 ${manualDifference>0?'+':''}${manualDifference}名</b><br><small>有効人数タイムラインへ反映中</small></span></div>`:'';
    list.innerHTML=named+correction||(effective?'<div class="history-item"><span>手動補正人数で稼働中です</span></div>':'<div class="history-item"><span>現在作業中の作業者はいません</span></div>');
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
    const start=minutes(state.operationStart||'09:30'),final=Math.max(start,...state.waves.filter(w=>w.planned>0).map(w=>minutes(w.cutoff))),first=start%60===0?start+60:Math.ceil(start/60)*60,out=[];
    for(let t=first;t<=final;t+=60)out.push(t);
    return out;
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
    const select=$('progressTargetTime'),current=Number(select.value),times=opsTargetMinutes();select.innerHTML=times.map(t=>`<option value="${t}">${clock(t)}時点${opsCheckpoint(t)?'（入力済み）':''}</option>`).join('');const manualOpen=Boolean($('manualProgressDetails')?.open),target=manualOpen&&times.includes(current)?current:opsNextTarget();if(Number.isFinite(target))select.value=String(target);renderProgressTiming();
  }
  function renderProgressTiming(){
    const target=Number($('progressTargetTime')?.value),checkpoint=opsCheckpoint(target);if(!Number.isFinite(target))return;const delay=nowMinutes()-target;
    $('progressTitle').textContent=`${clock(target)}時点の進捗`;$('progressTimingMessage').textContent=delay>0?`現在時刻 ${clock(nowMinutes())}・${delay}分遅れて入力しています`:delay===0?'現在時刻の対象データです':`${clock(target)}時点の後入力・修正ができます`;
    const previous=[...state.progressCheckpoints].filter(x=>x.targetMinute<target).sort((a,b)=>a.targetMinute-b.targetMinute).at(-1);$('quickCompleted').value=checkpoint?.totalCompleted??previous?.totalCompleted??0;
    const waveValue=checkpoint?.waveValues?.[$('quickWave').value];$('manualWaveCompleted').value=waveValue!==undefined?waveValue:(state.waves.find(w=>w.id===$('quickWave').value)?.completed||0);
  }
  $('progressTargetTime').addEventListener('change',renderProgressTiming);
  $('manualProgressDetails').addEventListener('toggle',()=>{if(!$('manualProgressDetails').open)renderProgressTarget()});

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
  function opsGlobalActualRate(){
    const checkpoints=[...state.progressCheckpoints].sort((a,b)=>a.targetMinute-b.targetMinute);
    if(!checkpoints.length)return 0;
    const end=checkpoints.at(-1),start=checkpoints.length>1?checkpoints.at(-2):{targetMinute:minutes(state.operationStart||'09:30'),totalCompleted:0};
    const productive=workingMinutes(start.targetMinute,end.targetMinute),processed=Math.max(0,Number(end.totalCompleted)-Number(start.totalCompleted));
    return productive>0&&processed>0?processed/(productive/60):0;
  }
  function goToProgressTarget(target){$('progressTargetTime').value=String(target);renderProgressTiming();$('progressPanel').scrollIntoView({behavior:'smooth',block:'start'})}
  window.goToProgressTarget=goToProgressTarget;
  function renderDashboard(){
    const rows=groupedRows(),latest=opsLatestCheckpoint(),target=latest?.targetMinute??minutes(state.operationStart||'09:30'),actual=latest?.totalCompleted??0,plan=opsPlanCumulativeAt(target),diff=actual-plan,human=opsHumanMinutes(new Date(opsTargetIso(minutes(state.operationStart||'09:30'))),new Date(opsTargetIso(target))),productivity=human?actual/(human/60):null,current=shipPaceCurrentWorkerCount(),pending=rows.filter(x=>x.item.planned>0&&!x.item.completedAt),finalPending=pending.at(-1),requirement=totalOperationalRequirement(rows,nowMinutes(),current),required=requirement.requiredWorkers,action=requirement.action;
    let finish=requirement.status==='complete'?'本日の作業は完了':requirement.status==='overdue'?'締切超過':pending.length?'実績蓄積中':'本日の便は完了';if(requirement.status==='active'&&finalPending){const rate=opsGlobalActualRate(),remaining=requirement.remaining,forecast=rate?finishAtRate(nowMinutes(),remaining,rate):null;if(forecast!==null){const delta=forecast-finalPending.deadline;finish=Math.abs(delta)<=2?'予定どおり完了見込み':`予定より約${Math.abs(delta)}分${delta<0?'早く':'遅れて'}完了見込み`}}
    const nextTarget=opsNextTarget(),cp=opsCheckpoint(nextTarget),tone=diff>0?'ahead':diff<0?'behind':'on-plan',requirementText=requirement.status==='overdue'?'算出対象外':`${required??0}名`,requirementDetail=requirement.status==='overdue'?`${requirement.detail}。残作業を確認してください。`:action;$('currentProgressDashboard').innerHTML=`<div class="ops-dashboard-head"><div><div class="eyebrow">CURRENT PROGRESS</div><h2>現在の進捗</h2></div><span class="ops-asof">${latest?clock(target)+'時点':'実績待ち'}</span></div><div class="ops-variance ${tone}">${opsDiffLabel(diff,'計画')}</div><div class="ops-dashboard-grid"><div class="ops-kpi"><small>計画・実績</small><strong>計画 ${plan.toLocaleString()}店舗 ｜ 実績 ${actual.toLocaleString()}店舗</strong></div><div class="ops-kpi"><small>累計 全体生産性</small><strong>${productivity===null?'実績待ち':productivity.toFixed(1)+' 店舗/人時'}</strong></div><div class="ops-kpi"><small>完了見込み</small><strong>${finish}</strong></div><div class="ops-kpi"><small>現在人数｜必要人数</small><strong>${current}名｜${requirementText}</strong></div><div class="ops-kpi"><small>最新の進捗入力</small><strong>${cp?'✓ 入力済み':nextTarget<=nowMinutes()?'⚠ 未入力':'― これから'}</strong></div></div><div class="ops-action ${requirement.status==='overdue'||requirement.gap>0?'warn':''}">${requirementDetail}</div>`;
  }

  function opsCorrectPaceCards(){
    const rows=groupedRows().filter(x=>x.item.planned>0),cards=[...$('paceGrid').querySelectorAll('.pace-card')],now=nowMinutes();
    cards.forEach((card,index)=>{const row=rows[index];if(!row)return;const done=Boolean(row.item.completedAt),awaiting=row.remaining===0&&!done,late=!done&&!awaiting&&now>=row.deadline,active=!done&&!awaiting&&now>=row.start&&now<row.deadline,status=done?'完了':awaiting?'完了確認待ち':late?'締切超過':active?'処理時間中':'待機',tone=done?'var(--green)':awaiting?'var(--amber)':late?'var(--red)':active?'var(--amber)':'var(--blue)',bg=done?'#f0faf6':awaiting?'#fff9ed':late?'#fff1f3':active?'#fff9ed':'#f7f9fd';card.style.setProperty('--tone',tone);card.style.setProperty('--card-bg',bg);const label=card.querySelector('.status');if(label)label.textContent=status;const forecast=card.querySelector('.note b');if(forecast&&!late){const finish=waveFinishDisplay(row,now);forecast.textContent=finish.label?`${finish.label} ${finish.value}`:finish.value}});
  }
  function opsShowBuild(){let badge=$('shipPaceBuild');if(!badge){badge=document.createElement('span');badge.id='shipPaceBuild';badge.style.cssText='font-size:10px;font-weight:900;color:#667085;white-space:nowrap';document.querySelector('header .ops-status')?.appendChild(badge)}if(badge)badge.textContent='v46'}

  function opsProgressValue(value){return Math.max(0,Number(value)||0)}
  function opsLatestWaveSnapshot(waveId){return state.progressSnapshots.filter(x=>x.waveId===waveId&&x.source!=='completion').sort((a,b)=>{const am=Number(a.targetMinute),bm=Number(b.targetMinute);if(Number.isFinite(am)&&Number.isFinite(bm)&&am!==bm)return am-bm;return new Date(a.targetAt||a.at)-new Date(b.targetAt||b.at)}).at(-1)}
  function opsReconcileCompletionState(){state.waves.forEach(w=>{const latest=opsLatestWaveSnapshot(w.id),completed=opsProgressValue(latest?latest.completed:w.completed);w.completed=completed;if(w.completedAt&&completed<Math.max(0,Number(w.planned)||0))w.completedAt=null})}
  const opsLegacyRender=render;
  render=function(){opsEnsureState();opsReconcileCompletionState();state.workers=shipPaceCurrentWorkerCount();opsLegacyRender();opsCorrectPaceCards();opsShowBuild();renderProgressTarget();renderDashboard();renderActiveWorkers();renderProgressStatus();renderHourlyProductivity();renderPerformance();renderWorkerMaster()};

  function recordProgressCheckpoint({id,completed,targetMinute,inputAt=new Date().toISOString(),source='manual_snapshot'}){
    const item=state.waves.find(w=>w.id===id),safeCompleted=opsProgressValue(completed),targetAt=opsTargetIso(targetMinute);let legacy=state.progressSnapshots.find(x=>x.waveId===id&&Number(x.targetMinute)===targetMinute);if(legacy)Object.assign(legacy,{completed:safeCompleted,at:targetAt,targetAt,inputAt,source});else state.progressSnapshots.push({id:opsUuid(),waveId:id,completed:safeCompleted,interval:0,at:targetAt,targetAt,inputAt,targetMinute,source});
    let checkpoint=opsCheckpoint(targetMinute);const priorValues=checkpoint?.waveValues||{};const waveValues=Object.fromEntries(state.waves.map(w=>{let value;if(w.id===id)value=safeCompleted;else if(priorValues[w.id]!==undefined)value=Number(priorValues[w.id])||0;else{const prior=state.progressSnapshots.filter(x=>x.waveId===w.id&&Number(x.targetMinute)<=targetMinute).sort((a,b)=>Number(a.targetMinute)-Number(b.targetMinute)).at(-1);value=Number(prior?.completed)||0}return[w.id,opsProgressValue(value)]})),totalCompleted=Object.values(waveValues).reduce((s,value)=>s+(Number(value)||0),0);if(checkpoint)Object.assign(checkpoint,{inputAt,totalCompleted,waveValues,updatedAt:inputAt});else{checkpoint={id:opsUuid(),targetMinute,targetAt,inputAt,totalCompleted,waveValues,createdAt:inputAt};state.progressCheckpoints.push(checkpoint)}state.progressCheckpoints.sort((a,b)=>a.targetMinute-b.targetMinute);state.progressSnapshots=state.progressSnapshots.slice(-1000);
    opsReconcileCompletionState();return{checkpoint,totalCompleted,targetAt,inputAt};
  }
  window.shipPaceRecordProgressCheckpoint=recordProgressCheckpoint;
  function opsOrderedWaves(){return state.waves.map((wave,index)=>({wave,index})).filter(x=>x.wave.planned>0).sort((a,b)=>minutes(a.wave.cutoff)-minutes(b.wave.cutoff)||a.index-b.index).map(x=>x.wave)}
  function opsAllocateGlobalTotal(total){
    const ordered=opsOrderedWaves(),values=Object.fromEntries(state.waves.map(w=>[w.id,0]));let remaining=Math.max(0,Math.round(Number(total)||0));
    ordered.forEach(w=>{const value=Math.min(remaining,Math.max(0,Number(w.planned)||0));values[w.id]=value;remaining-=value});
    if(remaining>0){const last=ordered.at(-1);if(last)values[last.id]+=remaining}
    return values;
  }
  function recordGlobalCheckpoint({totalCompleted,targetMinute,inputAt=new Date().toISOString(),source='global_snapshot'}){
    const requestedTotal=Math.max(0,Math.round(Number(totalCompleted)||0)),waveValues=opsAllocateGlobalTotal(requestedTotal),total=Object.values(waveValues).reduce((sum,value)=>sum+(Number(value)||0),0),targetAt=opsTargetIso(targetMinute);let checkpoint=opsCheckpoint(targetMinute);
    state.waves.forEach(w=>{const completed=Number(waveValues[w.id])||0;let snapshot=state.progressSnapshots.find(x=>x.waveId===w.id&&Number(x.targetMinute)===targetMinute);if(snapshot)Object.assign(snapshot,{completed,at:targetAt,targetAt,inputAt,source});else state.progressSnapshots.push({id:opsUuid(),waveId:w.id,completed,interval:0,at:targetAt,targetAt,inputAt,targetMinute,source})});
    if(checkpoint)Object.assign(checkpoint,{inputAt,totalCompleted:total,waveValues,updatedAt:inputAt,source});else{checkpoint={id:opsUuid(),targetMinute,targetAt,inputAt,totalCompleted:total,waveValues,createdAt:inputAt,source};state.progressCheckpoints.push(checkpoint)}
    state.progressCheckpoints.sort((a,b)=>a.targetMinute-b.targetMinute);state.progressSnapshots=state.progressSnapshots.slice(-1000);
    opsReconcileCompletionState();
    return{checkpoint,waveValues,totalCompleted:total,targetAt,inputAt};
  }
  function opsReachedCompletionCandidates(waveValues,targetMinute){
    return opsOrderedWaves().filter(w=>(Number(waveValues[w.id])||0)>=Number(w.planned)&&!w.completedAt&&!state.completionDismissals.some(x=>x.waveId===w.id&&x.targetMinute===targetMinute)).map(w=>({waveId:w.id,targetMinute,completed:Number(waveValues[w.id])||0}));
  }
  function opsShowNextCompletionCandidate(){
    while(opsCompletionQueue.length){
      const candidate=opsCompletionQueue.shift(),item=state.waves.find(w=>w.id===candidate.waveId),dismissed=state.completionDismissals.some(x=>x.waveId===candidate.waveId&&x.targetMinute===candidate.targetMinute);
      if(!item||item.completedAt||dismissed)continue;
      opsCompletionCandidate=candidate;$('completionPrompt').textContent=`${item.area}は計画${item.planned}店舗に到達しました（実績${candidate.completed}店舗）。この便の出荷作業は完了しましたか？`;$('completionModal').classList.add('open');return true;
    }
    opsCompletionCandidate=null;$('completionModal').classList.remove('open');return false;
  }
  function opsPromptReachedWaves(waveValues,targetMinute){
    opsCompletionQueue=opsReachedCompletionCandidates(waveValues,targetMinute);return opsShowNextCompletionCandidate();
  }
  function opsRestoreCompletionCandidates(){
    if(opsCompletionCandidate||opsCompletionQueue.length)return false;
    const latest=[...state.progressCheckpoints].filter(x=>x&&Number.isFinite(Number(x.targetMinute))&&x.waveValues).sort((a,b)=>Number(a.targetMinute)-Number(b.targetMinute)).at(-1);
    if(!latest)return false;
    opsCompletionQueue=opsReachedCompletionCandidates(latest.waveValues,Number(latest.targetMinute));
    return opsShowNextCompletionCandidate();
  }
  async function opsSaveSnapshot(){
    const requestedTotal=Math.max(0,Math.round(Number($('quickCompleted').value)||0)),targetMinute=opsNextTarget();if(!Number.isFinite(targetMinute))return;
    const existed=Boolean(opsCheckpoint(targetMinute)),{totalCompleted,waveValues}=recordGlobalCheckpoint({totalCompleted:requestedTotal,targetMinute});
    await saveState(existed?'shipping_snapshot_edit':'shipping_interval_progress');$('quickResult').innerHTML=`<strong>${clock(targetMinute)}時点の累計${totalCompleted.toLocaleString()}店舗を保存しました</strong><p>対象時刻と方面別進捗を自動判定し、計画差・生産性・必要ペースを再計算しました。</p>`;$('quickResult').scrollIntoView({behavior:'smooth',block:'center'});
    opsPromptReachedWaves(waveValues,targetMinute);
  }
  saveQuickProgress=opsSaveSnapshot;
  async function saveManualWaveProgress(){
    const id=$('quickWave').value,item=state.waves.find(x=>x.id===id),completed=Math.max(0,Math.round(Number($('manualWaveCompleted').value)||0)),targetMinute=Number($('progressTargetTime').value);if(!item||!Number.isFinite(targetMinute))return;
    const existed=Boolean(opsCheckpoint(targetMinute)),{checkpoint}=recordProgressCheckpoint({id,completed,targetMinute,source:'manual_wave_correction'});await saveState(existed?'shipping_snapshot_edit':'shipping_interval_progress');$('quickResult').innerHTML=`<strong>${clock(targetMinute)}時点の${escapeHtml(item.area)}を${completed.toLocaleString()}店舗へ修正しました</strong><p>関連する時間帯実績・人時・生産性を再計算しました。</p>`;opsPromptReachedWaves(checkpoint.waveValues,targetMinute);
  }
  window.saveManualWaveProgress=saveManualWaveProgress;
  async function confirmReachedWave(){const candidate=opsCompletionCandidate;if(!candidate)return;opsCompletionCandidate=null;await completeWave(candidate.waveId);$('quickResult').innerHTML=`<strong>${escapeHtml(state.waves.find(x=>x.id===candidate.waveId)?.area||'便')}を完了しました</strong><p>方面別 出荷締切へ反映し、次便の必要ペースと終了予測を再計算しました。</p>`;opsShowNextCompletionCandidate()}
  async function dismissReachedWave(){const c=opsCompletionCandidate;if(!c)return;opsCompletionCandidate=null;const item=state.waves.find(x=>x.id===c.waveId),at=new Date().toISOString(),deferred={...c,at};if(item)item.completedAt=null;state.completionDismissals=state.completionDismissals.filter(x=>!(x.waveId===c.waveId&&x.targetMinute===c.targetMinute));state.completionDismissals.push(deferred);rememberDeferredCompletion(deferred);await saveState('shipping_completion_deferred');$('quickResult').insertAdjacentHTML('beforeend',`<p><strong>${escapeHtml(item?.area||'便')}は未完了で保存しました。</strong> 便は完了扱いにせず、進捗だけを保存しています。</p>`);opsShowNextCompletionCandidate()}
  window.confirmReachedWave=confirmReachedWave;window.dismissReachedWave=dismissReachedWave;

  saveStartSettings=async function(){const next=operationStart.value||'09:30';state.operationStart=next;state.effectiveTime=next;opsRebuildStaffingTimeline();await saveState('shipping_start_change');workerMessage.textContent=`今日の計画開始を${next}に設定しました。作業者の人時は実際の参加時刻から計算します。`};
  applyWorkers=async function(){const count=Math.max(0,Number(workerChangeCount.value)||0),time=workerTime.value||clock(nowMinutes()),at=opsIsoAt(time);state.workers=count;state.effectiveTime=time;if(changeRateToggle.checked)state.onePersonRate=Math.max(1,Number(changeOnePersonRate.value)||state.onePersonRate);state.workerChanges.push({time,workers:count,onePersonRate:state.onePersonRate,operationStart:state.operationStart,kind:'manual_override',rateChanged:changeRateToggle.checked,savedAt:new Date().toISOString()});opsRecordStaffing(at,'manual_override',count,[]);await saveState('shipping_worker_change');workerMessage.textContent=`非常用修正：${time}から${count}名として人数タイムラインを修正しました。バーコード人数との二重計上はありません。`};
  const opsLegacyCompleteWave=completeWave;completeWave=async function(id){state.completionDismissals=state.completionDismissals.filter(x=>x.waveId!==id);forgetDeferredCompletion(id);await opsLegacyCompleteWave(id);render()};
  resetToday=async function(){if(!confirm('本日の完了店舗数・完了時刻・作業者記録をリセットしますか？'))return;state.waves.forEach(x=>{x.completed=0;x.completedAt=null});state.progressSnapshots=[];state.progressCheckpoints=[];state.workerSessions=[];state.staffingTimeline=[];state.completionDismissals=[];clearDeferredCompletionGuards();state.productivitySessions=(state.productivitySessions||[]).filter(x=>x.date!==state.date);state.activeProductivitySession=null;await saveState('shipping_reset');saveMessage.textContent='本日の実績・作業者・人数・進捗スナップショットをリセットしました。'};

  const opsLegacyReportText=reportText;reportText=function(){const latest=opsLatestCheckpoint(),human=latest?opsHumanMinutes(new Date(opsTargetIso(minutes(state.operationStart||'09:30'))),new Date(latest.targetAt)):0,allocation=opsPerformanceAllocation();return `${opsLegacyReportText()}\n\n【統合進捗】\n最新対象時刻 ${latest?clock(latest.targetMinute):'未入力'}\n累計全体生産性 ${latest&&human?(latest.totalCompleted/(human/60)).toFixed(1):'0.0'}店舗/人時\n現在作業中 ${shipPaceCurrentWorkerCount()}名\n時間帯進捗 ${state.progressCheckpoints.length}件\n共同作業区間 ${allocation.joint.length}件`};
  const opsLegacyReportSummary=reportSummary;reportSummary=function(){const base=opsLegacyReportSummary(),latest=opsLatestCheckpoint(),human=latest?opsHumanMinutes(new Date(opsTargetIso(minutes(state.operationStart||'09:30'))),new Date(latest.targetAt)):0;return{...base,currentWorkers:shipPaceCurrentWorkerCount(),workerMaster:state.workerMaster,workerSessions:state.workerSessions,staffingTimeline:state.staffingTimeline,progressCheckpoints:state.progressCheckpoints,hourlyProductivity:opsIntervalRows(),cumulativeHumanHours:human/60,cumulativeProductivity:latest&&human?latest.totalCompleted/(human/60):0,performance:opsPerformanceAllocation()}};

  function opsFoldSecondaryPanels(){
    const labels=new Map([['旧記録・手動補正','旧記録・手動補正'],['翌日分の出荷計画','翌日分の出荷計画'],['入力履歴・取り消し','入力履歴・取り消し'],['全方面トータル必要ペース','運用設定・手動修正']]);document.querySelectorAll('section.panel').forEach(section=>{const h=section.querySelector('h2'),label=labels.get(h?.textContent.trim());if(!h||!label||section.dataset.folded)return;const details=document.createElement('details');details.className=`panel details-panel ${section.classList.contains('future-panel')?'future-panel':''}`;details.dataset.folded='1';details.id=section.id;const summary=document.createElement('summary');summary.textContent=label;const inner=document.createElement('div');inner.className='details-inner';while(section.firstChild)inner.appendChild(section.firstChild);details.append(summary,inner);section.replaceWith(details)});
  }
  function opsOrganizeMainView(){
    const reminder=$('progressReminderPanel'),progress=$('progressPanel'),nextPanel=$('nextActionPanel'),pace=$('paceGrid')?.closest('.panel'),hourly=$('hourlyProductivity')?.closest('.panel'),ranking=$('personalRanking')?.closest('.panel'),settings=$('operationSettingsPanel');
    if(reminder&&progress)reminder.after(progress);if(progress&&nextPanel)progress.after(nextPanel);if(nextPanel&&pace)nextPanel.after(pace);if(pace&&hourly)pace.after(hourly);if(ranking&&settings)ranking.after(settings);
  }
  const opsLegacyRenderWithCompletionRestore=render;
  render=function(){opsLegacyRenderWithCompletionRestore();opsRestoreCompletionCandidates()};
  opsEnsureState();opsFoldSecondaryPanels();opsOrganizeMainView();render();
})();
