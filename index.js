'use strict';

const fs = require('fs');
const https = require('https');
const Agent = require('node-agent-sdk').Agent;

// Use a bot with the Agent profile
const conf = {
    accountId: process.env.LP_ACCOUNT,
    username: process.env.LP_USER,
    appKey: process.env.LP_APPKEY,
    secret: process.env.LP_SECRET,
    accessToken: process.env.LP_ACCESSTOKEN,
    accessTokenSecret: process.env.LP_ACCESSTOKENSECRET,
};

const agent = new Agent(conf);

// initialize bot, start keepalive, obtain Swift url
agent.on('connected', onConnected);
// accept incoming conversations
agent.on('routing.RoutingTaskNotification', onRoutingNotification);
// log errors
agent.on('error', onError);
// reconnect on disconnect
agent.on('closed', onClosed);
// process messaging events and download files if present
agent.on('ms.MessagingEventNotification', onMessagingEvent);

function onConnected () {
    console.log('connected...');
    // subscribe to routing tasks
    agent.subscribeRoutingTasks({}, e => {
        if (e) { console.error(e) }
        else console.log('subscribed to routing tasks')
    });
    // Set agent to online to receive incoming conversations
    agent.setAgentState({availability: 'ONLINE'});
    // Keep the connection alive
    agent._pingClock = setInterval(agent.getClock, 30000);
    // obtain this account's Swift domain from CSDS
    agent.csdsClient.getAll((err, domains) => {
        if (domains) {
            agent.swiftDomain = domains.swift;
            console.log(`swift domain: ${agent.swiftDomain}`);
        }
    })
}

function onError (err) {
    console.error('got an error', JSON.stringify(err))
}

function onClosed (data) {
    // For production environments ensure that you implement reconnect logic according to
    // liveperson's retry policy guidelines: https://developers.liveperson.com/guides-retry-policy.html
    console.log('socket closed', data);
    clearInterval(agent._pingClock);  // stop the keepalive
    agent.reconnect(); //regenerate token for reasons of authorization (data === 4401 || data === 4407)}
}

function onRoutingNotification (body) {
    body.changes.forEach(change => {
        if (change.type === 'UPSERT') {
            change.result.ringsDetails.forEach(ring => {
                if (ring.ringState === 'WAITING') {
                    console.log('incoming conversation');
                    agent.updateRingState({
                        'ringId': ring.ringId,
                        'ringState': 'ACCEPTED'
                    }, (e) => {
                        if (e) { console.error(`error accepting conversation ${JSON.stringify(e)}`) }
                        else console.log('conversation accepted')
                    });
                }
            });
        }
    });
}

function onMessagingEvent (body) {
    body.changes.forEach(change => {
        // if this is a file obtain the info needed to create the download URL
        if (change.event.type === 'ContentEvent' && change.event.message && change.event.message.relativePath) {
            console.log('file received');
            agent.generateURLForDownloadFile({relativePath: change.event.message.relativePath}, (err, data) => downloadFile(agent, data, body.dialogId));
        }
    });
}

function downloadFile (agent, data, dialogId) {
    // agent.swiftDomain was set in onConnected
    let url = `https://${agent.swiftDomain}${data.relativePath}?temp_url_sig=${data.queryParams.temp_url_sig}&temp_url_expires=${data.queryParams.temp_url_expires}`;
    console.log(url);
    let ext = data.relativePath.split('.').pop().toLowerCase();
    let ts = new Date().getTime();
    let file = fs.createWriteStream(`files/${conf.accountId}_${dialogId}_${ts}.${ext}`);
    https.get(url, response => {
        response
          .on('data', data => { file.write(data) })
          .on('end', () => {
            console.log('file downloaded');
            file.end();
        });
    });
}
