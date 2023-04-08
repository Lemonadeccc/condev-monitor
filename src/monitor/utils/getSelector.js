
function getSelectors(path){
  // console.log('getSelector-event',event)
  // const path = event.composedPath()
  console.log('getSelector-path',path)

    return path.reverse().filter(element => {
        return element !== document && element !== window;
    }).map(element => {
        let selector = ""
        if(element.id){
            return `${element.tagName.toLowerCase()}#${element.id}`
        }else if(typeof element.className === 'string'){
            return `${element.tagName.toLowerCase()}.${element.className}`
        }else{
            selector = element.tagName.toLowerCase();
        }
        return selector
    })
    .join(' ')
}


export default function(pathsOrTarget){
    if(Array.isArray(pathsOrTarget)){    //可能是一个数组
        return getSelectors(pathsOrTarget);
    }else{//也有可能是一个对象
        let path = []
        while(pathsOrTarget){
            path.push(pathsOrTarget)
            pathsOrTarget = pathsOrTarget.parentNode
        }
        return getSelectors(path)
    }
}