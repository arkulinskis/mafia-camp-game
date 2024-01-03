
rc = new RTCPeerConnection();
rc.onicecandidate = e => console.log("New Ice Candidate! reprinting SDP" + JSON.stringify(rc.localDescription))
rc.ondatachannel = e => { rc.dc = e.channel; rc.dc.onmessage = e => console.log("new message from client! " + e.data); rc.dc.onopen = e => console.log("connection OPENED!!!"); }
rc.setRemoteDescription(offer).then(a=>console.log("offer set!"))
rc.createAnswer().then(a => rc.setLocalDescription(a)).then(a => console.log("answer created") )
rc.dc.send("fine what about you")