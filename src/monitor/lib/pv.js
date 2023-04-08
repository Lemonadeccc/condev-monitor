import tracker from "../utils/tracker";
export function pv(){
  var connection = navigator.connection
  tracker.send({
    king:'business',
    type:'pv',
    effectiveType:connection.effectiveType,//网络环境
    ree:connection.rtt,//往返时间
    screen:`${window.screen.width}x${window.screen.height}`
  })
  let startTime = Date.now()
  window.addEventListener('unload',() => {
    let stayTime = Date.now() - startTime
    tracker.send({
      kind:'business',
      type:'stayTime',
      stayTime
    })
  },false)
}