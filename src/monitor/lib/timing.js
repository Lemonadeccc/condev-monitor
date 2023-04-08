import tracker from "../utils/tracker";
import onload from "../utils/onload";
import getLastEvent from "../utils/getLastEvent";
import getSelector from "../utils/getSelector";
export function timing() {

  // let perfEntries = window.performance.getEntriesByType("paint");

  // let paintObj = {};

  // for (let i = 0; i < perfEntries.length; i++) {
  //   let name = perfEntries[i].name;
  //   let time = perfEntries[i].startTime;

  //   switch (name) {
  //     case 'first-paint':
  //       paintObj.FP = time;
  //       break;
  //     case 'first-contentful-paint':
  //       paintObj.FCP = time;
  //       break;
  //     case 'largest-contentful-paint':
  //       paintObj.LCP = time;
  //       break;
  //     default:
  //       break;
  //   }
  // }

  // // Get FMP
  // let fmpEntries = window.performance.getEntriesByType("layout-shift");
  // if (fmpEntries.length > 0) {
  //   let fmpEntry = fmpEntries.pop();
  //   paintObj.FMP = fmpEntry.startTime;
  // }


  //增加一个性能条目的观察者
  // if (PerformanceObserver) {
    let FMP, LCP
    new PerformanceObserver((entryList, observer) => {
      let perfEntries = entryList.getEntries()
      FMP = perfEntries[0]    //startTime 3000 以后
      observer.disconnect()   //不再观察了
    }).observe({ entryTypes: ['element'] }) //观察页面中的意义元素

    new PerformanceObserver((entryList, observer) => {
      let perfEntries = entryList.getEntries()
      LCP = perfEntries[0]
      observer.disconnect() //不再观察了
    }).observe({ entryTypes: ['largest-contentful-paint'] })  //观察页面中的意义的元素


    //用户的第一次交互  点击页面 
    new PerformanceObserver((entryList, observer) => {
      let lastEvent = getLastEvent()
      let firstInput = entryList.getEntries()[0]
      console.log('FID', firstInput)
      if (firstInput) {
        //proessingStart开始处理的事件 startTime开始点击的时间 差值就是处理的延迟
        let inputDelay = firstInput.proessingStart - firstInput.startTime
        let duration = firstInput.duration //处理的耗时
        if (inputDelay > 0 || duration > 0) {
          tracker.send({
            king: 'experience',  //用户体验指标 ,Measuring TCP handshake time测量TCP握手时间 
            type: 'firstInputDelay',//首次输入延迟
            inputDelay,//延时的时间
            duration,//处理的时间
            startTime: firstInput.startTime,
            selector: lastEvent ? getSelector(lastEvent.path || lastEvent.target) : ''
          })

        }
      }
      observer.disconnect()   //不再观察了
    }).observe({ type: 'first-input', buffered: true })    //观察页面中的意义的元素
  // }





  onload(function () {
    setTimeout(() => {

      let perfEntries = window.performance.getEntriesByType("navigation");
      let navigation = perfEntries[0];

      tracker.send({
        king: 'experience',  //用户体验指标 ,Measuring TCP handshake time测量TCP握手时间 
        type: 'timing',//统计每个阶段的时间
        connectTime: navigation.connectEnd - navigation.connectStart,//连接时间
        ttfbTime: navigation.responseStart - navigation.requestStart,//首字节的时间//测量请求时间measuringRequestTime
        responseTime: navigation.responseEnd - navigation.redirectStart,//响应的读取时间, Measuring time to fetch (without redirects)测量获取时间（无重定向）
        parseDOMTime: navigation.loadEventStart - navigation.domInteractive,//DOM解析时间
        domContentLoadedTime: navigation.domContentLoadedEventEnd - navigation.domContentLoadedEventStart,//
        timeToInteractive: navigation.domInteractive - navigation.fetchStart,//首次可交互时间
        loadTime: navigation.loadEventStart - navigation.fetchStart,//完整的加载时间 

        measureDNSLookUpTime: navigation.domainLookupEnd - navigation.domainLookupStart,//测量 DNS 查找时间
        measuringRedirectionTime: navigation.redirectEnd - navigation.redirectStart,//测量重定向时间
        measuringTLSNegotiationTime: navigation.requestStart - navigation.secureConnectionStart,//测量 TLS 协商时间
        measuringServiceWorkerProcessingTime: navigation.fetchStart - navigation.workerStart,//测量 ServiceWorker 处理时间 
      })


      // const {
      //   unloadEventStart,
      //   unloadEventEnd,

      //   domInteractive,
      //   domContentLoadedEventStart,
      //   domContentLoadedEventEnd,
      //   domComplete,
      //   loadEventStart,
      //   loadEventEnd,

      //   redirectStart,
      //   redirectEnd,
      //   workerStart,
      //   fetchStart,
      //   domainLookupStart,
      //   domainLookupEnd,
      //   connectStart,
      //   secureConnectionStart,
      //   connectEnd,
      //   requestStart,
      //   responseStart,
      //   responseEnd,

      //   startTime,
      //   duration,
      //   entryType,
      //   name
      // } = PerformanceNavigationTiming.tojson

      // tracker.send({
      //   king:'experience',  //用户体验指标 ,Measuring TCP handshake time测量TCP握手时间 
      //   type:'timing',//统计每个阶段的时间
      //   connectTime: connectEnd - connectStart,//连接时间
      //   ttfbTime:responseStart - requestStart,//首字节的时间
      //   responseTime:responseEnd - redirectStart,//响应的读取时间, Measuring time to fetch (without redirects)测量获取时间（无重定向）
      //   parseDOMTime:loadEventStart - domInteractive,//DOM解析时间
      //   domContentLoadedTime:domContentLoadedEventEnd - domContentLoadedEventStart,//
      //   timeToInteractive:domInteractive - fetchStart,//首次可交互时间
      //   loadTime:loadEventStart - fetchStart,//完整的加载时间 

      //   measureDNSLookUpTime:domainLookupEnd - domainLookupStart,//测量 DNS 查找时间
      //   measuringRedirectionTime:redirectEnd - redirectStart,//测量重定向时间
      //   measuringRequestTime:responseStart - requestStart,//测量请求时间
      //   measuringTLSNegotiationTime:requestStart - secureConnectionStart,//测量 TLS 协商时间
      //   measuringServiceWorkerProcessingTime: fetchStart - workerStart,//测量 ServiceWorker 处理时间 
      // })


      //开始发送性能指标
      // console.log('AAAA',{...paintObj})

      let FP = performance.getEntriesByName('first-paint')[0]
      let FCP = performance.getEntriesByName('first-contentful-paint')[0]

      console.log('FP', FP)
      console.log('FCP', FCP)
      console.log('FMP', FMP)
      console.log('LCP', LCP)

      tracker.send({
        king: 'experience',  //用户体验指标 ,Measuring TCP handshake time测量TCP握手时间 
        type: 'paint',//统计每个阶段的时间
        firstPaint: FP.startTime,
        firstContentPaint: FCP.startTime,
        firstMeaningfulPaint: FMP.startTime,
        largestContentPaint: LCP.startTime,
      })

    }, 3000)
  })




}

//https://w3c.github.io/navigation-timing/#dom-performancenavigationtiming-domcomplete
//如今PerformanceNavigationTiming -> PerformanceResourceTiming  -> PerformanceEntry

//弃用performance.timing 改为PerformanceNavigationTiming和PerformanceResourceTiming
// https://developer.mozilla.org/en-US/docs/Web/API/PerformanceNavigationTiming
//https://developer.mozilla.org/en-US/docs/Web/API/PerformanceResourceTiming
//https://developer.mozilla.org/en-US/docs/Web/API/PerformanceEntry
// https://developer.mozilla.org/en-US/docs/Web/API/Performance/timing 已经废弃，旧版本用的
//https://developer.mozilla.org/en-US/docs/Web/Performance/Rum-vs-Synthetic 总的

//有很多监控服务。如果您确实想推出自己的监控系统，请查看性能 API，主要是PerformanceNavigationTiming和，PerformanceResourceTiming还有、 和。PerformanceMarkPerformanceMeasurePerformancePaintTiming