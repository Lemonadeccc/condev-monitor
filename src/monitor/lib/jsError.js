import getLastEvent from '../utils/getLastEvent.js'
import getSelector from '../utils/getSelector.js'
import tracker from '../utils/tracker.js';

export function injectError(){
    // console.log('RecsoureError');
    // console.log('injectError')

    // window.addEventListener('error',(error) => {
    //     console.log('errorA',error)
    // },true)

    //监听全局未捕获的错误
    window.addEventListener('error',(event) => {//错误实践对象
        console.log('jsError-error',event);
        const lastEvent = getLastEvent()//最后一个交互事件
        console.log('*(*(*((jsError)',lastEvent.composedPath())
        //错误事件对象
        // console.log(log)

       

        //这是一个脚本加载错误
        // if(event.target && (event.target.src || event.target.href)){
        //     tracker.send({
        //         kind:'stability',//监控指标的大类
        //         type:'error',//小类型，这是一个错误
        //         errorType:'resourceError',//js或css资源加载错误
        //         //url:'',//访问哪个路径报错
        //         //message:event.message,//报错信息
        //         filename:event.target.src || event.target.href,//哪个文件报错了
        //         tagName:event.target.tagName,//SCRIPT
        //         //stack: getLines(event.error.stack),
        //         //body div#container div.content input
        //         selector:getSelector(event.target) //代表最后一个操作的元素
        //     });
        // }else{
            tracker.send({
                kind:'stability',//监控指标的大类
                type:'error',//小类型，这是一个错误
                errorType:'jsError',//js执行错误
                //url:'',//访问哪个路径报错
                message:event.message,//报错信息
                filename:event.filename,//哪个文件报错了
                position:`${event.lineno}:${event.colno}`,//行和列报错的位置
                stack: getLines(event.error.stack),
                //body div#container div.content input
                selector:lastEvent ? getSelector(lastEvent.path) : '' //代表最后一个操作的元素
            });
        // }

    },true);

    window.addEventListener('unhandledrejection',(event) => {
        console.log(event)
        let lastEvent = getLastEvent()//最后一个交互事件
        let message
        let reason = event.reason
        let filename
        let line = 0
        let column = 0
        let stack = ''
        if(typeof reason === 'string'){
            message = reason
        }else if(typeof reason === 'object'){
            //说明是一个错误对象
            //at http://localhost:9000/:23:38\n 
            message = reason.message
            if(reason.stack){
                let matchResult = reason.stack.match(/at\s+(.+):(\d+):(\d+)/)
                filename = matchResult[1]
                line = matchResult[2]
                column = matchResult[3]
            }
            stack = getLines(reason.stack)
        }
        tracker.send({
            kind:'stability',//监控指标的大类
            type:'error',//小类型，这是一个错误
            errorType:'promiseError',//js执行错误
            //url:'',//访问哪个路径报错
            message,//报错信息
            filename,//哪个文件报错了
            position:`${line}:${column}`,//行和列报错的位置
            stack,
            //body div#container div.content input
            selector:lastEvent ? getSelector(lastEvent.path) : '' //代表最后一个操作的元素
        });
    },true)

    function getLines(stack){
        return stack.split('\n').slice(1).map(item=>item.replace(/^\s+at\s+/g,'')).join('^');
    }
}


//更改了packagejson中的webserver成最新的，注释了url， 添加了__log__。  selector还是undefined

//捕获不到 资源错误 因为mime的严格模式, 资源错误的话 不走  监听全局未捕获的错误这里面了。因为用console.log('errorAAA')验证了
//很可能是webpack把错误覆盖了