const lc = new RTCPeerConnection();
const dc = lc.createDataChannel("channel");
dc.onmessage = e => console.log("just got a message" + e.data);
dc.onopen = e => console.log("connection opened!");
lc.onicecandidate = e => console.log("new Ice candidate! reprinting SDP" + JSON.stringify(lc.localDescription));
lc.createOffer().then(o => lc.setLocalDescription(o)).then(a=>console.log("set sucessfully!"));