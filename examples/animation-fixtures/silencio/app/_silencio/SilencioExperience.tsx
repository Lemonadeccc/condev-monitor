'use client'

import { CondevAnimationProfiler, useCondevReactComponentScope } from '@condev-monitor/react/animation'
import {
    createRendererObjectResolverRegistry,
    createThreeRendererAdapter,
    createThreeRaycastObjectResolver,
    createWebGlGpuTimer,
} from '@condev-monitor/monitor-sdk-animation-renderer'
import { Profiler, type ReactNode, useEffect } from 'react'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { ScrollSmoother } from 'gsap/ScrollSmoother'
import { SplitText } from 'gsap/SplitText'
import Swiper from 'swiper'
import * as THREE from 'three'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js'
import { condevClient } from '@/instrumentation-client'

type ProductId = 'marco1' | 'marco2' | 'marco3' | 'marco4'

type SceneModel = {
    id: ProductId | 'basket'
    url: string
    position: THREE.Vector3
    rotation: THREE.Euler
    scale: THREE.Vector3
}

type SceneCleanup = {
    animations: Array<{ kill: () => void }>
    group: THREE.Group
}

type FloatConfig = {
    speed: number
    rotationIntensity: number
    floatIntensity: number
    floatingRange: [number, number]
}

type BuiltSceneModel = {
    root: THREE.Object3D
    target: THREE.Object3D
    initialTargetScale: number
}

type FloatingSceneModel = {
    group: THREE.Group
    config: FloatConfig
    seed: number
}

type ProductSceneHandle = {
    model: THREE.Object3D
    redLight?: THREE.PointLight
}

type KillableAnimation = { kill: () => void }

type ScrollSmootherVars = Parameters<typeof ScrollSmoother.create>[0] & {
    preventDefault?: boolean
}

type SilencioWindow = Window & {
    __silencioGroup?: THREE.Group
    __CONDEV_ANIMATION_LAB_OUTCOME__?: {
        register: (key: string, state: 'completed' | 'failed' | 'idle') => boolean
    }
}

const productScreens: Record<ProductId, string> = {
    marco1: 'pant1',
    marco2: 'pant2',
    marco3: 'pant3',
    marco4: 'pant4',
}

const productCards: Record<ProductId, string> = {
    marco1: '.etiqueta.uno',
    marco2: '.etiqueta.dos',
    marco3: '.etiqueta.tres',
    marco4: '.etiqueta.cuatro',
}

const productSections: Record<ProductId, string> = {
    marco1: '#tercera',
    marco2: '#aesthetics',
    marco3: '#motion',
    marco4: '#disruptive',
}

const floatConfigs: Record<SceneModel['id'], FloatConfig> = {
    marco1: {
        speed: 5,
        rotationIntensity: 0.5,
        floatIntensity: 0.5,
        floatingRange: [-0.01, 0.01],
    },
    marco2: {
        speed: 5,
        rotationIntensity: 1,
        floatIntensity: 1,
        floatingRange: [-0.05, 0.05],
    },
    marco3: {
        speed: 5,
        rotationIntensity: 1,
        floatIntensity: 1,
        floatingRange: [-0.05, 0.05],
    },
    marco4: {
        speed: 5,
        rotationIntensity: 1,
        floatIntensity: 1,
        floatingRange: [-0.05, 0.05],
    },
    basket: {
        speed: 2,
        rotationIntensity: 0.5,
        floatIntensity: 0.5,
        floatingRange: [-0.05, 0.05],
    },
}

const productRedLightPositions: Record<ProductId, [number, number, number]> = {
    marco1: [-5, -20, 5],
    marco2: [-5, -30, 5],
    marco3: [-5, -30, 5],
    marco4: [-5, -20, 5],
}

const scanRedLightIntensity = 10

const productScanScaleTargets: Record<ProductId, Partial<THREE.Vector3>> = {
    marco1: { x: 0, y: 0, z: 0 },
    marco2: { x: 0, z: 0 },
    marco3: { x: 0, y: 0, z: 0 },
    marco4: { x: 0, y: 0, z: 0 },
}

const sceneModels: SceneModel[] = [
    {
        id: 'marco1',
        url: '/can_silencio_c.glb',
        position: new THREE.Vector3(0, -0.5, 2),
        rotation: new THREE.Euler(0.3, -2, -0.2),
        scale: new THREE.Vector3(0.025, 0.025, 0.025),
    },
    {
        id: 'marco2',
        url: '/bolsa_silencio_c.glb',
        position: new THREE.Vector3(-3.5, 0, 0),
        rotation: new THREE.Euler(0, 0, 0),
        scale: new THREE.Vector3(0.03, 0.03, 0.03),
    },
    {
        id: 'marco3',
        url: '/zumo_silencio_c.glb',
        position: new THREE.Vector3(3.2, 0, 0),
        rotation: new THREE.Euler(0, -0.3, -0.6),
        scale: new THREE.Vector3(0.025, 0.025, 0.025),
    },
    {
        id: 'marco4',
        url: '/chocolatina_silencio_c.glb',
        position: new THREE.Vector3(0.5, 1.5, -0.7),
        rotation: new THREE.Euler(0, 0, 0),
        scale: new THREE.Vector3(0.03, 0.03, 0.03),
    },
    {
        id: 'basket',
        url: '/basket_c.glb',
        position: new THREE.Vector3(0, -8, 5),
        rotation: new THREE.Euler(Math.PI / 2, 0, 0),
        scale: new THREE.Vector3(0.1, 0.1, 0.1),
    },
]

function query<T extends Element>(selector: string): T | null {
    return document.querySelector<T>(selector)
}

const resolveSilencioRoot = () => query<HTMLElement>('#wrapper')

function playAudio(src: string) {
    const audio = new Audio(src)
    audio.play().catch(() => {
        // Autoplay policies can block non-user-initiated sounds.
    })
}

function setActiveScreen(screenId: string) {
    document.querySelectorAll('.pantallas').forEach(node => {
        node.classList.remove('on')
    })
    query(`#${screenId}`)?.classList.add('on')
}

function scanProduct(productId: ProductId, handle?: ProductSceneHandle) {
    const root = query(`#${productId}`)
    if (!root) return
    if (root.querySelector('.purchased')?.classList.contains('on')) return

    root.querySelector('.click')?.classList.add('on')
    root.querySelector('.lightbeep')?.classList.add('on')
    if (handle?.redLight) handle.redLight.intensity = scanRedLightIntensity

    gsap.to(`#${productId} .progressbar`, {
        duration: 0.5,
        width: window.innerWidth * 0.225,
        ease: 'power4.inOut',
    })

    window.setTimeout(() => {
        root.querySelector('.progressbar')?.classList.add('off')
        root.querySelector('.purchased')?.classList.add('on')
        root.querySelector('.lightbeep')?.classList.remove('on')
        if (handle?.redLight) handle.redLight.intensity = 0
        setActiveScreen(productScreens[productId])

        if (handle?.model) {
            gsap.to(handle.model.scale, {
                ...productScanScaleTargets[productId],
                duration: 0.2,
                ease: 'power4.inOut',
            })
        }
    }, 500)

    playAudio('/beep.mp3')
}

function splitIntroText(context: gsap.Context) {
    context.add(() => {
        document.querySelectorAll<HTMLElement>('.tit').forEach(node => {
            new SplitText(node, { type: 'chars, lines', charsClass: 'char' })
            new SplitText(node, { type: 'chars, lines', charsClass: 'charin' })
        })

        document.querySelectorAll<HTMLElement>('.tit1').forEach(node => {
            new SplitText(node, { type: 'words, lines', wordsClass: 'word' })
            new SplitText(node, { type: 'words', wordsClass: 'wordin' })
        })

        document.querySelectorAll<HTMLElement>('.titulos2').forEach(node => {
            const split = new SplitText(node, {
                type: 'lines,chars',
                charsClass: 'tit2',
            })
            new SplitText(node, { type: 'chars', charsClass: 'tit2in' })
            gsap.to(split.chars, {
                scrollTrigger: { trigger: node, start: 'top 90%' },
                y: 0,
                stagger: 0.03,
                duration: 1,
            })
        })

        document.querySelectorAll<HTMLElement>('.titulos3').forEach(node => {
            const split = new SplitText(node, {
                type: 'lines,words',
                linesClass: 'tit3',
            })
            new SplitText(node, { type: 'words', wordsClass: 'tit3in' })
            gsap.to(split.words, {
                scrollTrigger: { trigger: node, start: 'top 100%' },
                y: 0,
                stagger: 0.1,
                duration: 0.8,
            })
        })

        document.querySelectorAll<HTMLElement>('.text').forEach(node => {
            const split = new SplitText(node, {
                type: 'lines, words',
                linesClass: 'linein',
            })
            gsap.from(split.lines, {
                scrollTrigger: { trigger: node, start: 'top 100%' },
                duration: 0.8,
                ease: 'power4.out',
                y: window.innerWidth * 0.05,
                stagger: 0.08,
            })
        })

        new SplitText('.text', { type: 'lines', linesClass: 'line' })
    })
}

function updateMaterial(material: THREE.Material, values: Partial<THREE.MeshPhysicalMaterial>) {
    if (!(material instanceof THREE.MeshStandardMaterial)) return

    if (values.color) material.color.copy(values.color)
    if (values.roughness !== undefined) material.roughness = values.roughness
    if (values.metalness !== undefined) material.metalness = values.metalness
    if (values.envMapIntensity !== undefined) {
        material.envMapIntensity = values.envMapIntensity
    }

    if (material instanceof THREE.MeshPhysicalMaterial) {
        if (values.transmission !== undefined) {
            material.transmission = values.transmission
        }
        if (values.thickness !== undefined) material.thickness = values.thickness
        if (values.ior !== undefined) material.ior = values.ior
        if (values.attenuationDistance !== undefined) {
            material.attenuationDistance = values.attenuationDistance
        }
        if (values.attenuationColor instanceof THREE.Color) {
            material.attenuationColor.copy(values.attenuationColor)
        }
    }

    if (values.transparent !== undefined) {
        material.transparent = values.transparent
    }
    if (values.opacity !== undefined) material.opacity = values.opacity

    material.needsUpdate = true
}

function cloneMaterial(material: THREE.Material) {
    return material.clone()
}

function getPrimaryMaterial(mesh: THREE.Mesh) {
    return Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
}

function clonePrimaryMaterial(mesh: THREE.Mesh) {
    const material = getPrimaryMaterial(mesh)
    return material ? cloneMaterial(material) : new THREE.MeshStandardMaterial()
}

function getNamedMesh(model: THREE.Object3D, name: string) {
    const mesh = model.getObjectByName(name)
    return mesh instanceof THREE.Mesh ? mesh : null
}

function buildSceneModel(id: SceneModel['id'], source: THREE.Object3D): BuiltSceneModel {
    if (id === 'marco1') {
        const root = new THREE.Group()
        root.add(source)
        return { root, target: root, initialTargetScale: 0.025 }
    }

    if (id === 'marco2') {
        const packageMesh = getNamedMesh(source, 'package_01')
        if (!packageMesh) {
            return { root: source, target: source, initialTargetScale: 0.03 }
        }

        const root = new THREE.Group()
        const mesh = new THREE.Mesh(packageMesh.geometry, clonePrimaryMaterial(packageMesh))
        mesh.name = packageMesh.name
        mesh.rotation.set(-Math.PI / 2, -0.2, 0.1)
        mesh.scale.setScalar(100)
        root.add(mesh)
        return { root, target: mesh, initialTargetScale: 100 }
    }

    if (id === 'marco3') {
        const root = new THREE.Group()
        root.add(source)
        return { root, target: root, initialTargetScale: 0.025 }
    }

    if (id === 'marco4') {
        const candy = getNamedMesh(source, 'Candy_wrapper_v_8')
        if (!candy) {
            return { root: source, target: source, initialTargetScale: 0.03 }
        }

        const root = new THREE.Group()
        const mesh = new THREE.Mesh(candy.geometry, clonePrimaryMaterial(candy))
        mesh.name = candy.name
        mesh.castShadow = true
        mesh.receiveShadow = true
        mesh.position.set(0, 12, 0)
        mesh.rotation.set(0.1, 0.4, 0.4)
        root.add(mesh)
        return { root, target: mesh, initialTargetScale: 1 }
    }

    if (id === 'basket') {
        const root = new THREE.Group()
        root.add(source)
        return { root, target: root, initialTargetScale: 0.1 }
    }

    return { root: source, target: source, initialTargetScale: source.scale.x }
}

function createFloatGroup(model: THREE.Object3D, config: SceneModel): FloatingSceneModel {
    const floatGroup = new THREE.Group()
    floatGroup.add(model)

    return {
        group: floatGroup,
        config: floatConfigs[config.id],
        seed: Math.random() * 10000,
    }
}

function createProductRedLight(productId: ProductId) {
    const redLight = new THREE.PointLight(0xff0000, 0, 0)
    redLight.decay = 0
    redLight.position.fromArray(productRedLightPositions[productId])
    return redLight
}

function updateFloatingModel(model: FloatingSceneModel, elapsedTime: number) {
    const { speed, rotationIntensity, floatIntensity, floatingRange } = model.config
    const phase = model.seed + elapsedTime
    const wave = (phase / 4) * speed
    const floatY = THREE.MathUtils.mapLinear(Math.sin(wave) / 10, -0.1, 0.1, floatingRange[0], floatingRange[1])

    model.group.rotation.x = (Math.cos(wave) / 8) * rotationIntensity
    model.group.rotation.y = (Math.sin(wave) / 8) * rotationIntensity
    model.group.rotation.z = (Math.sin(wave) / 20) * rotationIntensity
    model.group.position.y = floatY * floatIntensity
}

function tuneModelMaterials(id: SceneModel['id'], model: THREE.Object3D) {
    model.traverse(child => {
        if (!(child instanceof THREE.Mesh)) return

        const material = Array.isArray(child.material) ? child.material[0] : child.material
        if (!material) return

        updateMaterial(material, { envMapIntensity: 1.25 })

        if (id === 'marco1') {
            if (/v_2$/i.test(child.name) || material.name === 'Mat.003') {
                updateMaterial(material, { metalness: 0, roughness: 0.2 })
            } else {
                updateMaterial(material, { roughness: 0.3 })
            }
        }

        if (id === 'marco2') {
            updateMaterial(material, { metalness: 0, roughness: 0.15 })
        }

        if (id === 'marco3') {
            if (/Wrapper/i.test(child.name)) {
                const wrapper = new THREE.MeshPhysicalMaterial({
                    color: new THREE.Color(0xffffff),
                    transparent: true,
                    transmission: 1,
                    roughness: 0,
                    thickness: 0.1,
                    ior: 2.1,
                    attenuationDistance: 1,
                    attenuationColor: new THREE.Color(0xffffff),
                    envMapIntensity: 1.6,
                })
                child.material = wrapper
                return
            }

            if (/Foil/i.test(child.name)) {
                updateMaterial(material, { metalness: 0.05, roughness: 0.18 })
            }

            if (/Box/i.test(child.name)) {
                updateMaterial(material, { metalness: 0, roughness: 0.25 })
            }

            if (/Straw/i.test(child.name)) {
                updateMaterial(material, { metalness: 0, roughness: 0.35 })
            }
        }

        if (id === 'marco4') {
            updateMaterial(material, { metalness: 0, roughness: 0.35 })
        }

        if (id === 'basket') {
            updateMaterial(material, { metalness: 1, roughness: 0.2 })
        }
    })
}

function tweenModelScale(model: THREE.Object3D, scale: number) {
    return gsap.to(model.scale, {
        x: scale,
        y: scale,
        z: scale,
        duration: 0.2,
        ease: 'power4.inOut',
    })
}

function syncProductScale(_productId: ProductId, model: THREE.Object3D, visibleScale: number) {
    return tweenModelScale(model, visibleScale)
}

function addProductCardAnimations(productId: ProductId, animations: KillableAnimation[]) {
    const innerWidth = window.innerWidth
    const innerHeight = window.innerHeight
    const pushTween = (tween: gsap.core.Tween) => animations.push(tween)

    pushTween(
        gsap.to(`#${productId} .progressbar`, {
            scrollTrigger: {
                trigger:
                    productId === 'marco1'
                        ? '#tercera'
                        : productId === 'marco2'
                          ? '#aesthetics'
                          : productId === 'marco3'
                            ? '#motion'
                            : '#disruptive',
                scrub: 0.2,
                start: 'bottom 0',
                end: 'bottom -50%',
            },
            width: innerWidth * 0.063,
            ease: 'power4.inOut',
            immediateRender: false,
        })
    )

    pushTween(
        gsap.from(`#${productId} .numero`, {
            scrollTrigger: {
                trigger: productCards[productId],
                scrub: 0.2,
                start: 'top 100%',
                end: 'top 25%',
            },
            x: -innerHeight * 0.2,
            ease: 'power4.inOut',
            immediateRender: false,
        })
    )

    if (productId === 'marco1' || productId === 'marco3') {
        pushTween(
            gsap.to(`#${productId} .numeroin`, {
                scrollTrigger: {
                    trigger: productId === 'marco1' ? '#tercera' : '#motion',
                    start: 'bottom -100%',
                    end: 'bottom -180%',
                    scrub: 0.2,
                },
                x: productId === 'marco1' ? -innerWidth * 0.053 : innerWidth * 0.057,
                ease: 'power4.inOut',
                immediateRender: false,
            })
        )
    }

    if (productId === 'marco2') {
        pushTween(
            gsap.to('#marco2 .numeroin', {
                scrollTrigger: {
                    trigger: '#aesthetics',
                    start: 'bottom -100%',
                    end: 'bottom -130%',
                    scrub: 0.2,
                },
                y: 0,
                ease: 'power4.inOut',
                immediateRender: false,
            })
        )
    }

    if (productId !== 'marco2') {
        pushTween(
            gsap.from(`#${productId} .lat2`, {
                scrollTrigger: {
                    trigger: `#${productId}`,
                    scrub: 0.2,
                    start: 'top 100%',
                    end: 'top 25%',
                },
                x: innerHeight * 0.2,
                ease: 'power4.inOut',
                immediateRender: false,
            })
        )
    }

    pushTween(
        gsap.from(`#${productId} .abajoizq`, {
            scrollTrigger: {
                trigger: `#${productId}`,
                scrub: 0.2,
                start: 'top 80%',
                end: 'top 25%',
            },
            x: -innerHeight * 0.2,
            ease: 'power4.inOut',
            immediateRender: false,
        })
    )

    if (productId !== 'marco2') {
        pushTween(
            gsap.from(`#${productId} .abajodch`, {
                scrollTrigger: {
                    trigger: `#${productId}`,
                    scrub: 0.2,
                    start: 'top 80%',
                    end: 'top 25%',
                },
                x: innerHeight * 0.2,
                ease: 'power4.inOut',
                immediateRender: false,
            })
        )
    }
}

function addDesktopModelAnimations(config: SceneModel, model: THREE.Object3D, visibleScale: number, cleanup: SceneCleanup) {
    const pushTween = (tween: gsap.core.Tween) => cleanup.animations.push(tween)
    const pushTrigger = (trigger: ScrollTrigger) => cleanup.animations.push(trigger)

    if (config.id === 'marco1') {
        pushTween(
            gsap.to(model.position, {
                scrollTrigger: {
                    trigger: '#landing',
                    scrub: 0.2,
                    start: 'top top',
                    end: 'bottom -100%',
                },
                x: 0,
                y: 0.2,
                z: 0,
                ease: 'power4.inOut',
                immediateRender: false,
            })
        )
        pushTween(
            gsap.to(model.rotation, {
                scrollTrigger: {
                    trigger: '#landing',
                    scrub: 0.2,
                    start: 'top top',
                    end: 'bottom -200%',
                },
                x: 0,
                y: -2,
                z: Math.PI * 2,
                ease: 'power4.inOut',
                immediateRender: false,
            })
        )
        pushTween(
            gsap.to(model.position, {
                scrollTrigger: {
                    trigger: '#landing',
                    scrub: 0.2,
                    start: 'top top',
                    end: 'bottom -150%',
                },
                y: 0.2,
                ease: 'power4.inOut',
                immediateRender: false,
            })
        )
        pushTrigger(
            ScrollTrigger.create({
                trigger: '#clients',
                start: 'bottom 140%',
                end: 'bottom 139%',
                onEnter: () => {
                    syncProductScale('marco1', model, 0.012)
                },
                onEnterBack: () => {
                    syncProductScale('marco1', model, visibleScale)
                },
            })
        )
        pushTween(
            gsap.to(model.position, {
                scrollTrigger: {
                    trigger: '#clients',
                    scrub: 0.2,
                    start: 'bottom 120%',
                    end: 'bottom 110%',
                },
                x: 3.3,
                y: 3,
                z: 3.8,
                ease: 'none',
                immediateRender: false,
            })
        )
        pushTween(
            gsap.to(model.rotation, {
                scrollTrigger: {
                    trigger: '#clients',
                    scrub: 0.2,
                    start: 'bottom 120%',
                    end: 'bottom 110%',
                },
                x: 0,
                y: 2,
                z: 1.5,
                ease: 'none',
                immediateRender: false,
            })
        )
        pushTween(
            gsap.to(model.position, {
                scrollTrigger: {
                    trigger: '#clients',
                    scrub: 0.2,
                    start: 'bottom 50%',
                    end: 'bottom 0',
                },
                x: 0.8,
                y: -0.5,
                z: 0.3,
                ease: 'none',
                immediateRender: false,
            })
        )
        pushTween(
            gsap.to(model.rotation, {
                scrollTrigger: {
                    trigger: '#clients',
                    scrub: 0.2,
                    start: 'bottom 50%',
                    end: 'bottom 0',
                },
                x: Math.PI / 2,
                y: 0.8,
                z: Math.PI / 2 + 0.1,
                ease: 'none',
                immediateRender: false,
            })
        )
    }

    if (config.id === 'marco2') {
        pushTween(
            gsap.to(model.position, {
                scrollTrigger: {
                    trigger: '#landing',
                    scrub: 0.2,
                    start: 'top top',
                    end: 'bottom -100%',
                },
                y: 280,
                ease: 'power4.inOut',
                immediateRender: false,
            })
        )
        pushTween(
            gsap.to(model.position, {
                scrollTrigger: {
                    trigger: '#aesthetics',
                    scrub: 0.2,
                    start: 'top 120%',
                    end: 'top bottom',
                },
                x: 200,
                ease: 'power4.inOut',
                immediateRender: false,
            })
        )
        pushTween(
            gsap.to(model.rotation, {
                scrollTrigger: {
                    trigger: '#aesthetics',
                    scrub: 0.2,
                    start: 'top bottom',
                    end: 'bottom top',
                },
                x: -1.5,
                y: 0.1 + Math.PI * 2,
                z: Math.PI * 6,
                ease: 'power4.inOut',
                immediateRender: false,
            })
        )
        pushTween(
            gsap.to(model.position, {
                scrollTrigger: {
                    trigger: '#aesthetics',
                    scrub: 0.2,
                    start: 'top bottom',
                    end: 'bottom top',
                },
                y: 0,
                z: 0,
                ease: 'power4.inOut',
                immediateRender: false,
            })
        )
        pushTrigger(
            ScrollTrigger.create({
                trigger: '#clients',
                start: 'bottom 140%',
                end: 'bottom 139%',
                onEnter: () => {
                    syncProductScale('marco2', model, 51)
                },
                onEnterBack: () => {
                    syncProductScale('marco2', model, visibleScale)
                },
            })
        )
        pushTween(
            gsap.to(model.position, {
                scrollTrigger: {
                    trigger: '#clients',
                    scrub: 0.2,
                    start: 'bottom 120%',
                    end: 'bottom 110%',
                },
                x: 120,
                y: 300,
                z: 120,
                ease: 'none',
                immediateRender: false,
            })
        )
        pushTween(
            gsap.to(model.rotation, {
                scrollTrigger: {
                    trigger: '#clients',
                    scrub: 0.2,
                    start: 'bottom 120%',
                    end: 'bottom 110%',
                },
                x: 0,
                y: 2,
                z: 0,
                ease: 'none',
                immediateRender: false,
            })
        )
        pushTween(
            gsap.to(model.position, {
                scrollTrigger: {
                    trigger: '#clients',
                    scrub: 0.2,
                    start: 'bottom 50%',
                    end: 'bottom 0',
                },
                x: 120,
                y: 0,
                z: 0,
                ease: 'none',
                immediateRender: false,
            })
        )
        pushTween(
            gsap.to(model.rotation, {
                scrollTrigger: {
                    trigger: '#clients',
                    scrub: 0.2,
                    start: 'bottom 50%',
                    end: 'bottom 0',
                },
                x: -Math.PI / 2,
                y: 0,
                z: 0,
                ease: 'none',
                immediateRender: false,
            })
        )
    }

    if (config.id === 'marco3') {
        pushTween(
            gsap.to(model.position, {
                scrollTrigger: {
                    trigger: '#landing',
                    scrub: 0.2,
                    start: 'top top',
                    end: 'bottom -100%',
                },
                y: 7,
                ease: 'power4.inOut',
                immediateRender: false,
            })
        )
        pushTween(
            gsap.to(model.position, {
                scrollTrigger: {
                    trigger: '#motion',
                    scrub: 0.2,
                    start: 'top 110%',
                    end: 'top bottom',
                },
                x: 0,
                ease: 'power4.inOut',
                immediateRender: false,
            })
        )
        pushTween(
            gsap.to(model.rotation, {
                scrollTrigger: {
                    trigger: '#motion',
                    scrub: 0.2,
                    start: 'top 110%',
                    end: 'top bottom',
                },
                y: 1,
                z: 2,
                ease: 'power4.inOut',
                immediateRender: false,
            })
        )
        pushTween(
            gsap.to(model.rotation, {
                scrollTrigger: {
                    trigger: '#motion',
                    scrub: 0.2,
                    start: 'top bottom',
                    end: 'bottom 0',
                },
                y: Math.PI * 2,
                z: Math.PI * 2 + 0.5,
                ease: 'power4.inOut',
                immediateRender: false,
            })
        )
        pushTween(
            gsap.to(model.position, {
                scrollTrigger: {
                    trigger: '#motion',
                    scrub: 0.2,
                    start: 'top bottom',
                    end: 'bottom 0',
                },
                y: 0.3,
                ease: 'power4.inOut',
                immediateRender: false,
            })
        )
        pushTrigger(
            ScrollTrigger.create({
                trigger: '#clients',
                start: 'bottom 140%',
                end: 'bottom 139%',
                onEnter: () => {
                    syncProductScale('marco3', model, 0.012)
                },
                onEnterBack: () => {
                    syncProductScale('marco3', model, visibleScale)
                },
            })
        )
        pushTween(
            gsap.to(model.position, {
                scrollTrigger: {
                    trigger: '#clients',
                    scrub: 0.2,
                    start: 'bottom 120%',
                    end: 'bottom 110%',
                },
                x: -0.5,
                y: 5,
                z: 2.5,
                ease: 'none',
                immediateRender: false,
            })
        )
        pushTween(
            gsap.to(model.rotation, {
                scrollTrigger: {
                    trigger: '#clients',
                    scrub: 0.2,
                    start: 'bottom 120%',
                    end: 'bottom 110%',
                },
                x: 3,
                y: 0,
                z: 1,
                ease: 'none',
                immediateRender: false,
            })
        )
        pushTween(
            gsap.to(model.position, {
                scrollTrigger: {
                    trigger: '#clients',
                    scrub: 0.2,
                    start: 'bottom 50%',
                    end: 'bottom 0',
                },
                x: -1.5,
                y: 0,
                z: 0.8,
                ease: 'none',
                immediateRender: false,
            })
        )
        pushTween(
            gsap.to(model.rotation, {
                scrollTrigger: {
                    trigger: '#clients',
                    scrub: 0.2,
                    start: 'bottom 50%',
                    end: 'bottom 0',
                },
                x: 0,
                y: 0,
                z: 0.5,
                ease: 'none',
                immediateRender: false,
            })
        )
    }

    if (config.id === 'marco4') {
        pushTween(
            gsap.to(model.position, {
                scrollTrigger: {
                    trigger: '#landing',
                    scrub: 0.2,
                    start: 'top top',
                    end: 'bottom -100%',
                },
                y: 180,
                ease: 'power4.inOut',
                immediateRender: false,
            })
        )
        pushTween(
            gsap.to(model.position, {
                scrollTrigger: {
                    trigger: '#disruptive',
                    scrub: 0.2,
                    start: 'top 110%',
                    end: 'top bottom',
                },
                x: -70,
                ease: 'power4.inOut',
                immediateRender: false,
            })
        )
        pushTween(
            gsap.to(model.position, {
                scrollTrigger: {
                    trigger: '#disruptive',
                    scrub: 0.2,
                    start: 'top bottom',
                    end: 'bottom 0',
                },
                y: -30,
                ease: 'power4.inOut',
                immediateRender: false,
            })
        )
        pushTween(
            gsap.to(model.rotation, {
                scrollTrigger: {
                    trigger: '#disruptive',
                    scrub: 0.2,
                    start: 'top bottom',
                    end: 'bottom 0',
                },
                x: 0.2 + Math.PI * 2,
                y: 0.3 + Math.PI * 2,
                z: 1,
                ease: 'power4.inOut',
                immediateRender: false,
            })
        )
        pushTrigger(
            ScrollTrigger.create({
                trigger: '#clients',
                start: 'bottom 140%',
                end: 'bottom 139%',
                onEnter: () => {
                    syncProductScale('marco4', model, 0.37)
                },
                onEnterBack: () => {
                    syncProductScale('marco4', model, visibleScale)
                },
            })
        )
        pushTween(
            gsap.to(model.position, {
                scrollTrigger: {
                    trigger: '#clients',
                    scrub: 0.2,
                    start: 'bottom 120%',
                    end: 'bottom 110%',
                },
                x: 0,
                y: 100,
                z: 90,
                ease: 'none',
                immediateRender: false,
            })
        )
        pushTween(
            gsap.to(model.rotation, {
                scrollTrigger: {
                    trigger: '#clients',
                    scrub: 0.2,
                    start: 'bottom 120%',
                    end: 'bottom 110%',
                },
                x: 1,
                y: 0.5,
                z: 4,
                ease: 'none',
                immediateRender: false,
            })
        )
        pushTween(
            gsap.to(model.position, {
                scrollTrigger: {
                    trigger: '#clients',
                    scrub: 0.2,
                    start: 'bottom 50%',
                    end: 'bottom 0',
                },
                x: -30,
                y: -80,
                z: 60,
                ease: 'none',
                immediateRender: false,
            })
        )
        pushTween(
            gsap.to(model.rotation, {
                scrollTrigger: {
                    trigger: '#clients',
                    scrub: 0.2,
                    start: 'bottom 50%',
                    end: 'bottom 0',
                },
                x: 0,
                y: 0,
                z: 0.5,
                ease: 'none',
                immediateRender: false,
            })
        )
    }

    if (config.id === 'basket') {
        const handleLeft = model.getObjectByName('Asa2')
        const handleRight = model.getObjectByName('Asa1')

        pushTween(
            gsap.to(model.position, {
                scrollTrigger: {
                    trigger: '#clients',
                    scrub: 0.2,
                    start: 'top 0%',
                    end: 'top -1%',
                },
                y: 0,
                ease: 'none',
                immediateRender: false,
            })
        )
        pushTween(
            gsap.to(model.position, {
                scrollTrigger: {
                    trigger: '#clients',
                    scrub: 0.2,
                    start: 'bottom 100%',
                    end: 'bottom 0%',
                },
                x: 0,
                y: -1.6,
                z: 0,
                ease: 'none',
                immediateRender: false,
            })
        )
        pushTween(
            gsap.to(model.rotation, {
                scrollTrigger: {
                    trigger: '#clients',
                    scrub: 0.2,
                    start: 'bottom 100%',
                    end: 'bottom 0%',
                },
                x: 0.3,
                y: 0.8,
                z: 0,
                ease: 'none',
                immediateRender: false,
            })
        )

        if (handleLeft) {
            pushTween(
                gsap.to(handleLeft.rotation, {
                    scrollTrigger: {
                        trigger: '#clients',
                        scrub: 0.2,
                        start: 'bottom 50%',
                        end: 'bottom 0%',
                    },
                    z: -2.6,
                    ease: 'none',
                    immediateRender: false,
                })
            )
        }

        if (handleRight) {
            pushTween(
                gsap.to(handleRight.rotation, {
                    scrollTrigger: {
                        trigger: '#clients',
                        scrub: 0.2,
                        start: 'bottom 50%',
                        end: 'bottom 0%',
                    },
                    z: 2.6,
                    ease: 'none',
                    immediateRender: false,
                })
            )
        }
    }
}

function revealDesktopExperience(cleanup: SceneCleanup) {
    const content = query('#content')

    if (query('#aceptar')?.classList.contains('out')) return

    content?.classList.remove('fix')
    query('#superiorstart')?.classList.add('ready')
    query('#aceptar')?.classList.add('out')
    query('#wrapper')?.classList.add('ready')
    query('#fixworks')?.classList.add('ready')
    query('#lateral')?.classList.add('ready')
    query('#barcode1')?.classList.add('ready')
    query('#limited')?.classList.add('ready')

    gsap.to('.charin', {
        delay: 0.3,
        y: 0,
        stagger: 0.03,
        duration: 1,
        ease: 'power4.out',
    })
    gsap.to('#landing h3', {
        delay: 1,
        y: 0,
        duration: 1,
        ease: 'power4.out',
    })
    gsap.to('.wordin', {
        delay: 1,
        y: 0,
        stagger: 0.015,
        duration: 1,
        ease: 'power4.out',
    })
    gsap.to(cleanup.group.rotation, {
        duration: 2,
        x: 0,
        y: 0,
        z: 0,
        ease: 'power4.inOut',
        immediateRender: false,
    })
    gsap.to(cleanup.group.position, {
        duration: 2,
        x: 0,
        y: 0,
        z: 0,
        ease: 'power4.inOut',
        immediateRender: false,
    })

    window.setTimeout(() => {
        query('#scroll')?.classList.add('ready')
        query('#ticket')?.classList.add('start')
        window.setTimeout(() => playAudio('/print1.2.mp3'), 100)
    }, 2000)

    window.setTimeout(() => {
        query('#superiorstart')?.classList.add('out')
        query('#superior')?.classList.add('ready')
    }, 1000)

    ScrollTrigger.refresh()
}

function prepareDesktopExperience(cleanup: SceneCleanup) {
    const content = query('#content')

    query('#preloader')?.classList.add('ready')
    query('#preloader')?.setAttribute('data-state', 'ready')
    window.setTimeout(() => query('#aceptar')?.classList.add('ready'), 4000)
    content?.classList.add('fix')
    window.scrollTo(0, 0)

    cleanup.animations.push(
        gsap.from(cleanup.group.position, {
            y: -20,
            duration: 4,
            ease: 'power4.inOut',
            immediateRender: false,
        })
    )
    cleanup.animations.push(
        gsap.from(cleanup.group.rotation, {
            duration: 4,
            y: Math.PI * 1.5,
            ease: 'power4.inOut',
            immediateRender: false,
        })
    )
    cleanup.animations.push(
        gsap.to('#lateralinner', {
            scrollTrigger: {
                trigger: '#content',
                start: 'top top',
                end: 'bottom bottom',
                scrub: 0.2,
            },
            x: -window.innerHeight - window.innerWidth * 4.504,
            ease: 'none',
            immediateRender: false,
        })
    )
}

function initThreeScene(isMobile: boolean) {
    const mount = query<HTMLElement>(isMobile ? '#canvasmov' : '#root')
    if (!mount) return () => {}

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, isMobile ? 500 : 30)
    camera.position.set(0, 0, 8)

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(window.innerWidth, window.innerHeight)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1
    mount.appendChild(renderer.domElement)

    const gl = renderer.getContext()
    const backend = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext ? 'webgl2' : 'webgl'
    const rendererMonitor = createThreeRendererAdapter({
        animation: condevClient.animation,
        renderer,
        backend,
        gpuTimer: {
            timer: createWebGlGpuTimer({
                gl,
                backend,
                disjointQueryOwnership: 'exclusive',
                sampleEvery: 60,
            }),
            ownership: 'adapter',
        },
        target: { element: renderer.domElement },
    })

    const group = new THREE.Group()
    group.rotation.set(1, 0, 0)
    group.position.set(0, 0, -3)
    scene.add(group)
    const productSceneHandles = new Map<ProductId, ProductSceneHandle>()
    const outcomeBridge = (window as SilencioWindow).__CONDEV_ANIMATION_LAB_OUTCOME__
    const objectResolvers = outcomeBridge ? createRendererObjectResolverRegistry() : null
    const unregisterProductResolver = objectResolvers
        ? objectResolvers.register(
              'silencio.product.primary',
              createThreeRaycastObjectResolver({
                  canvas: renderer.domElement,
                  raycaster: new THREE.Raycaster(),
                  camera,
                  getObjects: () => {
                      const primaryProduct = productSceneHandles.get('marco1')?.model
                      return primaryProduct ? [primaryProduct] : []
                  },
                  recursive: true,
              })
          )
        : () => {}
    const reportProductHit = (event: PointerEvent) => {
        if (
            objectResolvers?.resolve('silencio.product.primary', {
                clientX: event.clientX,
                clientY: event.clientY,
            }).status === 'hit'
        ) {
            outcomeBridge?.register('silencio.product.raycast-hit', 'completed')
        }
    }
    if (outcomeBridge) {
        window.addEventListener('pointermove', reportProductHit, {
            passive: true,
        })
    }
    if (!isMobile) {
        ;(window as SilencioWindow).__silencioGroup = group
    }

    scene.add(new THREE.AmbientLight(0xffffff, 1.8))
    const keyLight = new THREE.DirectionalLight(0xffffff, 2)
    keyLight.position.set(2, 4, 6)
    scene.add(keyLight)

    const dracoLoader = new DRACOLoader()
    dracoLoader.setDecoderPath('/draco/')

    const loader = new GLTFLoader()
    loader.setDRACOLoader(dracoLoader)
    const pmremGenerator = new THREE.PMREMGenerator(renderer)
    pmremGenerator.compileEquirectangularShader()
    let environmentMap: THREE.Texture | null = null
    const hdrLoader = new HDRLoader()
    const floatingModels: FloatingSceneModel[] = []
    const cleanup: SceneCleanup = { animations: [], group }
    const productHandlers: Array<{ card: Element; handler: EventListener }> = []
    let loadedModels = 0

    hdrLoader.load('/studio_small_09_1k_low.hdr', hdrTexture => {
        environmentMap = pmremGenerator.fromEquirectangular(hdrTexture).texture
        scene.environment = environmentMap
        hdrTexture.dispose()
    })

    sceneModels.forEach(config => {
        loader.load(
            config.url,
            gltf => {
                const builtModel = buildSceneModel(config.id, gltf.scene)
                builtModel.root.position.copy(config.position)
                builtModel.root.rotation.copy(config.rotation)
                builtModel.root.scale.copy(config.scale)
                tuneModelMaterials(config.id, builtModel.root)
                const floatingModel = createFloatGroup(builtModel.root, config)
                floatingModels.push(floatingModel)

                if (config.id !== 'basket') {
                    const redLight = createProductRedLight(config.id)
                    floatingModel.group.add(redLight)
                    productSceneHandles.set(config.id, {
                        model: builtModel.target,
                        redLight,
                    })
                }

                if (config.id === 'basket') {
                    scene.add(floatingModel.group)
                } else {
                    group.add(floatingModel.group)
                }

                if (!isMobile) {
                    addDesktopModelAnimations(config, builtModel.target, builtModel.initialTargetScale, cleanup)
                }

                loadedModels += 1
                if (loadedModels === sceneModels.length) {
                    ;(window as SilencioWindow).__CONDEV_ANIMATION_LAB_OUTCOME__?.register('silencio.scene.loaded', 'completed')
                    if (isMobile) {
                        query('#preloader')?.classList.add('ready')
                        query('#preloader')?.setAttribute('data-state', 'ready')
                    } else {
                        window.setTimeout(() => {
                            prepareDesktopExperience(cleanup)
                        }, 500)
                    }
                }
            },
            undefined,
            error => {
                console.error(`Failed to load 3D model: ${config.url}`, error)
            }
        )
    })

    const resize = () => {
        camera.aspect = window.innerWidth / window.innerHeight
        camera.updateProjectionMatrix()
        renderer.setSize(window.innerWidth, window.innerHeight)
    }
    window.addEventListener('resize', resize)

    let frame = 0
    const clock = new THREE.Clock()
    const render = () => {
        frame = window.requestAnimationFrame(render)
        const elapsedTime = clock.getElapsedTime()
        floatingModels.forEach(model => updateFloatingModel(model, elapsedTime))
        rendererMonitor.render(scene, camera)
    }
    render()

    sceneModels
        .filter((model): model is SceneModel & { id: ProductId } => model.id !== 'basket')
        .forEach(model => {
            const card = query(productCards[model.id])
            const handler = () => scanProduct(model.id, productSceneHandles.get(model.id))

            if (card) {
                card.addEventListener('click', handler)
                productHandlers.push({ card, handler })
            }

            if (!isMobile) {
                cleanup.animations.push(
                    ScrollTrigger.create({
                        trigger: productSections[model.id],
                        start: 'bottom -50%',
                        onEnter: trigger => {
                            scanProduct(model.id, productSceneHandles.get(model.id))
                            trigger.disable()
                        },
                    })
                )
            }
        })

    return () => {
        cleanup.animations.forEach(animation => animation.kill())
        productHandlers.forEach(({ card, handler }) => {
            card.removeEventListener('click', handler)
        })
        window.cancelAnimationFrame(frame)
        window.removeEventListener('resize', resize)
        if (outcomeBridge) {
            window.removeEventListener('pointermove', reportProductHit)
        }
        unregisterProductResolver()
        objectResolvers?.dispose()
        if ((window as SilencioWindow).__silencioGroup === group) {
            delete (window as SilencioWindow).__silencioGroup
        }
        environmentMap?.dispose()
        pmremGenerator.dispose()
        dracoLoader.dispose()
        rendererMonitor.dispose()
        renderer.dispose()
        renderer.domElement.remove()
    }
}

function initDesktop(context: gsap.Context) {
    const smootherVars: ScrollSmootherVars = {
        wrapper: '#wrapper',
        content: '#content',
        smooth: 1,
        normalizeScroll: true,
        ignoreMobileResize: true,
        effects: true,
        preventDefault: true,
    }
    const smoother = ScrollSmoother.create(smootherVars)
    const desktopAnimations: KillableAnimation[] = []

    ScrollTrigger.create({
        trigger: '#root',
        start: 'top 0',
        end: 'top -20000%',
        scrub: 0.2,
        pin: '#root',
        pinSpacing: false,
    })

    const moveCursor = (event: MouseEvent) => {
        gsap.to('#aceptar div', {
            x: event.pageX,
            y: event.pageY,
            duration: 0.1,
            ease: 'power4.inOut',
        })
    }
    document.addEventListener('mousemove', moveCursor)

    context.add(() => {
        document.fonts.ready.then(() => {
            query('#aceptar')?.classList.add('fonts')
            query('#silenciostart')?.classList.add('ready')

            gsap.to('#silenciostart', {
                duration: 1.5,
                x: 0,
                ease: 'power4.out',
            })
            gsap.to('#superiormask div', {
                delay: 1,
                duration: 0.8,
                y: 0,
                stagger: 0.3,
                ease: 'power4.out',
            })
        })
    })

    const openWorks = () => {
        query('#fixworks')?.classList.add('open')
        query('#barcode1')?.classList.remove('ready')
    }

    ScrollTrigger.create({
        trigger: '#landing',
        start: 'top -40%',
        end: 'top -41%',
        onEnter: openWorks,
    })

    gsap.to('#scroll div', {
        scrollTrigger: {
            trigger: '#landing',
            start: 'top 0',
            end: 'top -30%',
            scrub: 0.2,
        },
        autoAlpha: 0,
        ease: 'power4.inOut',
    })

    gsap.to('#inferior div', {
        scrollTrigger: {
            trigger: '#segunda',
            start: 'top 80%',
            end: 'top 50%',
            scrub: 0.2,
        },
        stagger: 0.5,
        autoAlpha: 1,
        ease: 'power4.inOut',
    })
    ;(
        [
            ['.etiqueta.uno', '#tercera', '#border1', 0.325, '-200%'],
            ['.etiqueta.dos', '#aesthetics', '#border2', 0, '-100%'],
            ['.etiqueta.tres', '#motion', '#border3', -0.325, '-200%'],
            ['.etiqueta.cuatro', '#disruptive', '#border4', 0, '-300%'],
        ] as const
    ).forEach(([pin, trigger, border, x, end]) => {
        ScrollTrigger.create({
            trigger: pin,
            start: 'top 0',
            end: `top ${end}`,
            scrub: 0.2,
            pin,
        })
        gsap.to(border, {
            scrollTrigger: {
                trigger,
                start: 'bottom -70%',
                end: 'bottom -100%',
                scrub: 0.2,
            },
            width: window.innerWidth * 0.07,
            height: window.innerWidth * 0.07,
            ease: 'power4.inOut',
        })
        gsap.to(border, {
            scrollTrigger: {
                trigger,
                start: 'bottom -100%',
                end: 'bottom -180%',
                scrub: 0.2,
            },
            x: window.innerWidth * Number(x),
            ease: 'power4.inOut',
        })
    })

    addProductCardAnimations('marco1', desktopAnimations)
    addProductCardAnimations('marco2', desktopAnimations)
    addProductCardAnimations('marco3', desktopAnimations)
    addProductCardAnimations('marco4', desktopAnimations)

    ScrollTrigger.create({
        trigger: '#final',
        start: 'top 0',
        end: 'top -100%',
        scrub: 0.2,
        pin: '#final',
    })

    gsap.to('.interactive', {
        scrollTrigger: {
            trigger: '#tercera',
            start: 'bottom -200%',
            end: 'bottom -220%',
            scrub: 0.2,
        },
        autoAlpha: 1,
        ease: 'power4.inOut',
    })

    gsap.to('.websites', {
        scrollTrigger: {
            trigger: '#aesthetics',
            start: 'bottom -100%',
            end: 'bottom -120%',
            scrub: 0.2,
        },
        autoAlpha: 1,
        ease: 'power4.inOut',
    })

    gsap.to('.communication', {
        scrollTrigger: {
            trigger: '#motion',
            start: 'bottom -200%',
            end: 'bottom -220%',
            scrub: 0.2,
        },
        autoAlpha: 1,
        ease: 'power4.inOut',
    })

    gsap.to('#root', {
        scrollTrigger: {
            trigger: '#landing',
            start: 'top 0',
            end: 'top -200%',
            scrub: 0.2,
        },
        filter: 'blur(0px)',
        ease: 'power4.inOut',
    })

    gsap.to('#backtop', {
        scrollTrigger: {
            trigger: '#clients',
            start: 'bottom 10%',
            end: 'bottom 0',
            scrub: 0.2,
        },
        autoAlpha: 1,
        ease: 'power4.inOut',
    })

    const backTop = query('#backtop')
    const scrollTop = () => smoother.scrollTo(0, true)
    backTop?.addEventListener('click', scrollTop)

    const aceptar = query('#aceptar')
    const enterExperience = () => {
        const group = (window as SilencioWindow).__silencioGroup
        if (!group) return
        revealDesktopExperience({ animations: desktopAnimations, group })
    }
    aceptar?.addEventListener('click', enterExperience)

    ScrollTrigger.create({
        trigger: '#final2',
        start: 'top 1%',
        onEnter: trigger => {
            query('#ticket')?.classList.add('final')
            playAudio('/print2.1.mp3')
            trigger.disable()
        },
    })

    splitIntroText(context)

    return () => {
        aceptar?.removeEventListener('click', enterExperience)
        backTop?.removeEventListener('click', scrollTop)
        document.removeEventListener('mousemove', moveCursor)
        desktopAnimations.forEach(animation => animation.kill())
        smoother.kill()
    }
}

function initMobile() {
    document.fonts.ready.then(() => {
        new SplitText('#largemov div', { type: 'words' })
        query('#preloader')?.classList.add('ready')
        query('#preloader')?.setAttribute('data-state', 'ready')
        query('#aceptar')?.classList.add('out')
        query('#wrapper')?.classList.add('ready')
        query('#barcode1')?.classList.add('ready')
        query('#limited')?.classList.add('ready')
    })

    const swiper = new Swiper('.mySwiper', {
        centeredSlides: true,
        slidesPerView: 'auto',
    })

    const info = query('#infosmov')
    const ticket = query('#ticket')
    const toggleTicket = () => {
        if (info?.classList.contains('on')) {
            ticket?.classList.remove('up')
            info.classList.remove('on')
        } else {
            ticket?.classList.add('up')
            info?.classList.add('on')
            playAudio('/print2.1.mp3')
        }
    }
    info?.addEventListener('click', toggleTicket)

    return () => {
        info?.removeEventListener('click', toggleTicket)
        swiper.destroy(true, true)
    }
}

export function SilencioExperience({ children }: { children: ReactNode }) {
    const experienceMonitor = useCondevReactComponentScope({
        client: condevClient,
        label: 'Silencio experience',
        resolveTarget: resolveSilencioRoot,
    })

    useEffect(() => {
        gsap.registerPlugin(ScrollTrigger, ScrollSmoother, SplitText)

        const context = gsap.context(() => {})
        const isMobile = window.innerWidth < 1024
        const cleanupThree = initThreeScene(isMobile)
        const cleanupMode = isMobile ? initMobile() : initDesktop(context)

        const copyButton = query('#copymail')
        const copied = query('#copied')
        const copyEmail = () => {
            navigator.clipboard.writeText('porfavor@silencio.es').catch(() => {})
            copied?.classList.add('on')
            window.setTimeout(() => copied?.classList.remove('on'), 2000)
        }
        copyButton?.addEventListener('click', copyEmail)

        window.onunload = () => {
            window.scrollTo(0, 0)
        }

        return () => {
            copyButton?.removeEventListener('click', copyEmail)
            cleanupMode?.()
            cleanupThree()
            context.revert()
            ScrollTrigger.getAll().forEach(trigger => trigger.kill())
        }
    }, [])

    return (
        <CondevAnimationProfiler client={condevClient}>
            <Profiler id="condev-silencio-experience" onRender={experienceMonitor.onRender}>
                {children}
            </Profiler>
        </CondevAnimationProfiler>
    )
}
