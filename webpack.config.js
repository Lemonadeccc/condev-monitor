const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
module.exports = {
    entry:'./src/index.js',
    context:process.cwd(),
    mode:'development',
    output:{
        path:path.resolve(__dirname,'dist'),
        filename:'monitor.js'
    },
    devServer:{
        // contentBase:path.resolve(__dirname,'dist')
        //新版的webpack中的属性代替了旧的contentbase
        static: {
            directory: path.join(__dirname, 'dist'),
          },
        compress: true,
        port: 9000,
        // headers:{
        //     "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src *;"
        // },
        setupMiddlewares: (middlewares, devServer) => { //用来配置路由的时候的， express服务器
            if (!devServer) {
              throw new Error('webpack-dev-server is not defined');
            }
      
            devServer.app.get('/setup-middleware/some/path', (_, response) => {
                response.send('setup-middlewares option GET');
              });
      
            // 如果你想在所有其他中间件之前运行一个中间件或者当你从 `onBeforeSetupMiddleware` 配置项迁移时，
            // 可以使用 `unshift` 方法
            middlewares.unshift({
              name: 'ajax-success',
              // `path` 是可选的
              path: '/success',
              middleware: (req, res) => {
                res.json({id:1});       //200
                // req.sendStatus(500)
              },
            });

            // 如果你想在所有其他中间件之前运行一个中间件或者当你从 `onBeforeSetupMiddleware` 配置项迁移时，
            // 可以使用 `unshift` 方法
            middlewares.unshift({
                name: 'ajax-error',
                // `path` 是可选的
                path: '/error',
                middleware: (req, res) => {
                //   res.json({id:1});
                  req.sendStatus(500)       //500
                },
              });
      
            // 如果你想在所有其他中间件之后运行一个中间件或者当你从 `onAfterSetupMiddleware` 配置项迁移时，
            // 可以使用 `push` 方法
            middlewares.push({
              name: 'hello-world-test-one',
              // `path` 是可选的
              path: '/foo/bar',
              middleware: (req, res) => {
                res.send('Foo Bar!');
              },
            });
      
            middlewares.push((req, res) => {
              res.send('Hello World!');
            });
      
            return middlewares;
          },
        },

    plugins:[
        new HtmlWebpackPlugin({
            template:'./src/index.html',
            inject:'head'
        })
    ]
}


// setupMiddlewares代替了webpack4中的before。 及其.get和.post的方法