import { z } from 'zod';

/**
 * 新数据格式的运行时 schema。
 *
 * 说明：这是渐进式收紧的第一版。为保证迁移现有塔不误报，未知字段一律通过
 * `catchall(z.unknown())` 保留，只约束必须存在的关键字段。后续可逐步收紧。
 */

/** 事件块内部结构复杂且随版本扩展，暂不约束 */
export const eventBlockSchema = z.record(z.string(), z.unknown());

export const locSchema = z.object({
    x: z.number(),
    y: z.number(),
});

export const enemySchema = z
    .object({
        name: z.string(),
        hp: z.number(),
        atk: z.number(),
        def: z.number(),
        money: z.number(),
        exp: z.number(),
        point: z.unknown().optional(),
        special: z.unknown().optional(),
    })
    .catchall(z.unknown());

export const itemSchema = z
    .object({
        cls: z.string().optional(),
        name: z.string(),
        text: z.string().optional(),
        hideInToolbox: z.boolean().optional(),
    })
    .catchall(z.unknown());

export const mapElementSchema = z
    .object({
        cls: z.string(),
        id: z.string(),
    })
    .catchall(z.unknown());

export const changeFloorEntrySchema = z
    .object({
        floorId: z.string(),
        loc: z.array(z.number()).optional(),
        stair: z.string().optional(),
        direction: z.string().optional(),
        time: z.number().optional(),
    })
    .nullable();

export const changeFloorSchema = z.record(z.string(), changeFloorEntrySchema);

export const floorSchema = z
    .object({
        floorId: z.string(),
        title: z.string(),
        name: z.string(),
        map: z.array(z.array(z.number())),
        events: z.record(z.string(), z.unknown()).optional(),
        changeFloor: changeFloorSchema.optional(),
    })
    .catchall(z.unknown());

export const towerDataSchema = z
    .object({
        main: z
            .object({
                floorIds: z.array(z.string()),
                /** 使用的 tileset 文件名，按顺序决定 X+编号 的偏移 */
                tilesets: z.array(z.string()).optional(),
            })
            .catchall(z.unknown()),
        firstData: z
            .object({
                title: z.string(),
                name: z.string(),
                version: z.string(),
                floorId: z.string(),
                hero: z
                    .object({
                        loc: z
                            .object({
                                x: z.number(),
                                y: z.number(),
                            })
                            .catchall(z.unknown())
                            .optional(),
                    })
                    .catchall(z.unknown())
                    .optional(),
            })
            .catchall(z.unknown()),
        values: z.record(z.string(), z.unknown()),
        flags: z.record(z.string(), z.unknown()),
    })
    .catchall(z.unknown());

export const enemysSchema = z.record(z.string(), enemySchema);
export const itemsSchema = z.record(z.string(), itemSchema);
export const mapsSchema = z.record(z.string(), mapElementSchema);
const iconMap = z.record(z.string(), z.number());

export const iconsSchema = z
    .object({
        terrains: iconMap.optional(),
        animates: iconMap.optional(),
        npcs: iconMap.optional(),
        npc48: iconMap.optional(),
        enemys: iconMap.optional(),
        enemy48: iconMap.optional(),
        items: iconMap.optional(),
    })
    .catchall(z.unknown());
export const eventsSchema = z
    .object({
        commonEvent: z.record(z.string(), z.unknown()),
    })
    .catchall(z.unknown());

export const floorMapSchema = z.record(z.string(), floorSchema);

export type Enemy = z.infer<typeof enemySchema>;
export type Item = z.infer<typeof itemSchema>;
export type MapElement = z.infer<typeof mapElementSchema>;
export type FloorData = z.infer<typeof floorSchema>;
export type TowerData = z.infer<typeof towerDataSchema>;
export type Enemys = z.infer<typeof enemysSchema>;
export type Items = z.infer<typeof itemsSchema>;
export type Maps = z.infer<typeof mapsSchema>;
export type Icons = z.infer<typeof iconsSchema>;
export type CommonEvents = z.infer<typeof eventsSchema>;
