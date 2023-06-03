import React, {useState} from "react";
import {useDocsSidebar} from "@docusaurus/theme-common/internal";
import Layout from "@theme/Layout";
import BackToTopButton from "@theme/BackToTopButton";
import DocPageLayoutSidebar from "@theme/DocPage/Layout/Sidebar";
import DocPageLayoutMain from "@theme/DocPage/Layout/Main";
import type {Props} from "@theme/DocPage/Layout";

import styles from "./styles.module.css";
import Navbar from "@docusaurus/theme-classic/lib/theme/Navbar";

export default function DocPageLayout({ children }: Props): JSX.Element {
	const sidebar = useDocsSidebar();
	const [hiddenSidebarContainer, setHiddenSidebarContainer] = useState(false);
	return (
		<Layout wrapperClassName={styles.docsWrapper}>
			<BackToTopButton />
			<div className={styles.docPage}>
				{sidebar && (
					<DocPageLayoutSidebar
						sidebar={sidebar.items}
						hiddenSidebarContainer={hiddenSidebarContainer}
						setHiddenSidebarContainer={setHiddenSidebarContainer}
					/>
				)}
				<div >
					{/* CUSTOM CODE - insert navbar here */}
					<Navbar />
					<DocPageLayoutMain hiddenSidebarContainer={hiddenSidebarContainer}>
						{children}
					</DocPageLayoutMain>
				</div>
			</div>
		</Layout>
	);
}
