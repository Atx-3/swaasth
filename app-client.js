// public/app-client.js
const socket = io();

function id(x){ return document.getElementById(x); }

// local state
let pc = null;
let localStream = null;
let remoteSocketId = null;
let roomId = null;
let localName = localStorage.getItem('swasth_name') || null;
window.roomOthers = [];

(async function initRoom() {
  if (!localName) {
    localName = prompt('Your name for calls (will be stored locally):') || 'User';
    localStorage.setItem('swasth_name', localName);
  }
  roomId = new URLSearchParams(window.location.search).get('room') || 
           prompt('Enter room id to join (use same room on both tabs):', 'swasth-demo');
  socket.emit('join-room', roomId, { name: localName });
})();

socket.on('room-participants', (others) => {
  window.roomOthers = others;
  console.log('room participants', others);
});
socket.on('user-joined', ({ socketId, userMeta }) => {
  console.log('user-joined', socketId, userMeta);
});

// ---- Peer connection ----
function createPeerConnection() {
  const config = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  pc = new RTCPeerConnection(config);

  const remotePlaceholder = id('remote-video-placeholder');
  const remoteVideo = document.createElement('video');
  remoteVideo.id = 'remote-video';
  remoteVideo.autoplay = true;
  remoteVideo.playsInline = true;
  remoteVideo.style.width = '100%';
  remoteVideo.style.height = '100%';

  if (remotePlaceholder && remotePlaceholder.tagName === 'IMG') {
    remotePlaceholder.replaceWith(remoteVideo);
  } else if (remotePlaceholder) {
    remotePlaceholder.innerHTML = '';
    remotePlaceholder.appendChild(remoteVideo);
  }

  const remoteStream = new MediaStream();
  pc.ontrack = (e) => {
    e.streams[0].getTracks().forEach(t => remoteStream.addTrack(t));
    remoteVideo.srcObject = remoteStream;
  };

  pc.onicecandidate = (event) => {
    if (event.candidate && remoteSocketId) {
      socket.emit('ice-candidate', { toSocketId: remoteSocketId, candidate: event.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      endCallLocalCleanup();
    }
  };

  return pc;
}

// ----- Start Calls -----
window.startVideoCall = async function startVideoCall(doctorName) {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    id('local-video').srcObject = localStream;
    id('video-call-doctor-name').textContent = doctorName;
    if (typeof showScreen === 'function') showScreen('video-call-screen');

    pc = createPeerConnection();
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const others = window.roomOthers || [];
    if (others.length === 0) {
      alert('No other participant in room. Open another tab with same room id.');
      return;
    }
    remoteSocketId = others[0];
    socket.emit('call-user', { toSocketId: remoteSocketId, offer, fromMeta: { name: localName }});
  } catch (err) {
    console.error('startVideoCall error', err);
    alert('Could not access camera/microphone.');
  }
};

window.startVoiceCall = async function startVoiceCall(doctorName) {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    id('voice-call-doctor-name').textContent = doctorName;
    if (typeof showScreen === 'function') showScreen('voice-call-screen');

    pc = createPeerConnection();
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const others = window.roomOthers || [];
    if (others.length === 0) {
      alert('No other participant in room. Open another tab with same room id.');
      return;
    }
    remoteSocketId = others[0];
    socket.emit('call-user', { toSocketId: remoteSocketId, offer, fromMeta: { name: localName }});
  } catch (err) {
    console.error('startVoiceCall error', err);
    alert('Could not access microphone.');
  }
};

// ----- Incoming Call with Modal -----
let pendingCall = null;

socket.on('incoming-call', ({ from, offer, fromMeta }) => {
  console.log('incoming-call', from, fromMeta);
  pendingCall = { from, offer, fromMeta };
  const modal = id('incoming-call-modal');
  const txt = id('incoming-call-text');
  if (txt) txt.textContent = `${fromMeta?.name || 'Caller'} is calling...`;
  if (modal) modal.classList.remove('hidden');
});

// Called from index.html when Accept pressed
window.acceptIncomingCall = async function acceptIncomingCall() {
  if (!pendingCall) return;
  const { from, offer, fromMeta } = pendingCall;
  pendingCall = null;
  id('incoming-call-modal').classList.add('hidden');

  remoteSocketId = from;
  const wantsVideo = offer && offer.sdp && offer.sdp.includes('m=video');

  try {
    localStream = await navigator.mediaDevices.getUserMedia(wantsVideo ? { video: true, audio: true } : { audio: true });
    if (wantsVideo) id('local-video').srcObject = localStream;

    pc = createPeerConnection();
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('answer-call', { toSocketId: from, answer });

    if (wantsVideo) {
      if (typeof showScreen === 'function') showScreen('video-call-screen');
      id('video-call-doctor-name').textContent = fromMeta?.name || 'Doctor';
    } else {
      if (typeof showScreen === 'function') showScreen('voice-call-screen');
      id('voice-call-doctor-name').textContent = fromMeta?.name || 'Doctor';
    }
  } catch (err) {
    console.error('Error accepting call', err);
    alert('Could not get media for incoming call.');
  }
};

// Called from index.html when Reject pressed
window.rejectIncomingCall = function rejectIncomingCall() {
  if (!pendingCall) return;
  socket.emit('reject-call', { toSocketId: pendingCall.from });
  pendingCall = null;
  id('incoming-call-modal').classList.add('hidden');
};

socket.on('call-accepted', async ({ from, answer }) => {
  try {
    if (!pc) return;
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
  } catch (err) { console.error(err); }
});

socket.on('call-rejected', ({ from }) => {
  alert('Call rejected by remote user.');
  endCallLocalCleanup();
});

socket.on('ice-candidate', async ({ from, candidate }) => {
  try {
    if (pc && candidate) await pc.addIceCandidate(candidate);
  } catch (err) { console.error('addIce failed', err); }
});

// ----- Cleanup -----
function endCallLocalCleanup() {
  try {
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    if (pc) { pc.close(); pc = null; }
    remoteSocketId = null;
    if (typeof showScreen === 'function') showScreen('doctor-chat-screen');
  } catch (err) { console.error(err); }
}

window.endVideoCall = function endVideoCall() {
  endCallLocalCleanup();
  if (typeof activeDoctorChat !== 'undefined') {
    activeDoctorChat.chatHistory.push({ sender: 'system', text: 'Video call ended' });
    if (typeof renderDoctorChatHistory === 'function') renderDoctorChatHistory();
  }
};

window.endVoiceCall = function endVoiceCall() {
  endCallLocalCleanup();
  if (typeof activeDoctorChat !== 'undefined') {
    activeDoctorChat.chatHistory.push({ sender: 'system', text: 'Voice call ended' });
    if (typeof renderDoctorChatHistory === 'function') renderDoctorChatHistory();
  }
};

// ----------------- FILE UPLOAD (unchanged) -----------------
async function uploadFileAndReturnUrl(file) {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch('/upload', { method: 'POST', body: fd });
  const j = await res.json();
  if (j && j.url) return j;
  throw new Error('Upload failed');
}

const fileUploadEl = id('file-upload');
if (fileUploadEl) {
  fileUploadEl.addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const j = await uploadFileAndReturnUrl(f);
      if (typeof activeDoctorChat !== 'undefined') {
        activeDoctorChat.chatHistory.push({ sender: 'user', text: `Sent a file: ${f.name}`, fileUrl: j.url });
        if (typeof renderDoctorChatHistory === 'function') renderDoctorChatHistory();
      }
    } catch (err) { alert('Upload failed'); console.error(err); }
    e.target.value = '';
  });
}

window.submitNewDocument = async function submitNewDocument() {
  const nameInput = id('new-document-name');
  const fileInput = id('new-document-file');
  if (!nameInput || !fileInput || !nameInput.value || fileInput.files.length === 0) {
    return alert('Enter name and choose file.');
  }
  const file = fileInput.files[0];
  try {
    const j = await uploadFileAndReturnUrl(file);
    if (typeof medicalRecords !== 'undefined') {
      medicalRecords.unshift({
        id: Date.now(),
        name: nameInput.value,
        date: new Date().toISOString().split('T')[0],
        file: { name: file.name, url: j.url }
      });
      if (typeof renderMedicalRecords === 'function') renderMedicalRecords();
    }
    closeAddDocumentModal();
  } catch (err) {
    alert('Upload failed');
    console.error(err);
  }
};
